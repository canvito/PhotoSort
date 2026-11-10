"""Group photos and videos by a plain-language request, e.g. "birthday party last Sunday", into one folder.

A local model (text only) turns the request into a topic, a media type and a date range. Capture dates come from
the files' own metadata (or OneDrive-style names), and each file in range is checked by a local vision model.
Only the user's request text and the files' pixels go to the local PAIR proxy; nothing goes to a cloud model.
"""
from __future__ import annotations

import json
import re
from collections import Counter
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

from PIL import Image

from media import video_tags

GROUP_MARKER = "_photosort_group.json"
CALENDAR_DAYS = 63  # nine weeks of dated weekdays in the prompt, so "last Sunday" is a lookup, not arithmetic
UNDERSTAND_VOTES = 3  # the request is read this many times in parallel; dates and media must agree
WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
MEDIA = ("photos", "videos", "both")
EVENT_NIGHT_HOURS = 4  # with a topic, a day's photos run to 4 am the next day (a party that goes past midnight)
NAME_MARGIN = timedelta(days=2)  # a UTC file name more than this outside the dates cannot be in range (time zones
# are at most 14 h apart), so the file is not even opened
WINDOWS_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}

# OneDrive camera upload names (20261108_193012000_iOS.jpg) are in UTC: checked against EXIF date + offset on 286
# real photos (286/286), and they equal Apple's capture date on 228/228 videos.
ONEDRIVE_NAME = re.compile(r"^(\d{8})_(\d{6})\d{3}_(?:iOS|Android)", re.I)
CAMERA_NAME = re.compile(r"^(?:IMG|VID|PXL|MVIMG)_(\d{8})_(\d{6})")  # Android camera apps, local time
SCREENSHOT_NAME = re.compile(r"^Screenshot[ _](\d{4})-?(\d{2})-?(\d{2})", re.I)  # local time

REQUEST_SCHEMA = {  # the model copies the request's words first, then turns them into fields (in this order)
    "type": "object", "required": ["file_words", "when_words", "what_words", "topic", "media", "date_from",
                                   "date_to", "people_named", "folder_name"],
    "properties": {"file_words": {"type": "string"}, "when_words": {"type": "string"},
                   "what_words": {"type": "string"}, "topic": {"type": "string"},
                   "media": {"type": "string", "enum": list(MEDIA)},
                   "date_from": {"type": "string"}, "date_to": {"type": "string"},
                   "people_named": {"type": "array", "items": {"type": "string"}},
                   "folder_name": {"type": "string"}}}
MATCH_SCHEMA = {"type": "object", "required": ["match", "confidence"],
                "properties": {"match": {"type": "boolean"}, "confidence": {"type": "number"}}}


class GroupError(ValueError):
    pass


# ---------- capture dates ----------

def _plausible(dt: datetime | None) -> datetime | None:
    return dt if dt and 1990 <= dt.year and dt <= datetime.now() + timedelta(days=2) else None


def _local(utc: datetime) -> datetime:
    """A UTC time as this PC's local wall-clock time."""
    return utc.replace(tzinfo=timezone.utc).astimezone().replace(tzinfo=None)


def _exif_time(value) -> datetime | None:
    try:
        return _plausible(datetime.strptime(str(value).strip().rstrip("\x00")[:19], "%Y:%m:%d %H:%M:%S"))
    except (TypeError, ValueError):
        return None


def _iso_time(value: str | None, wall_clock: bool) -> datetime | None:
    """ISO time from video metadata. wall_clock: keep the time in its own offset (where it was taken);
    otherwise convert a UTC time to this PC's local time."""
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.split(";")[0].strip().replace("Z", "+00:00"))  # PyAV joins repeats with ;
    except ValueError:
        return None
    if dt.tzinfo is None:
        return _plausible(dt)
    return _plausible(dt.replace(tzinfo=None) if wall_clock else _local(dt.astimezone(timezone.utc).replace(tzinfo=None)))


def _name_time(name: str) -> datetime | None:
    try:
        if m := ONEDRIVE_NAME.match(name):
            return _plausible(_local(datetime.strptime(m[1] + m[2], "%Y%m%d%H%M%S")))
        if m := CAMERA_NAME.match(name):
            return _plausible(datetime.strptime(m[1] + m[2], "%Y%m%d%H%M%S"))
        if m := SCREENSHOT_NAME.match(name):
            return _plausible(datetime(int(m[1]), int(m[2]), int(m[3])))
    except ValueError:
        pass
    return None


def capture_time(path: Path, video: bool) -> tuple[datetime | None, str]:
    """When a photo or video was taken, as local wall-clock time, and where that came from.

    Photos: EXIF DateTimeOriginal (the camera's local time), else the file name. Videos: Apple's capture date
    (local time with its offset), else the file name, else the container's creation_time (UTC; edited or
    exported clips get a later one, so it comes last). The file's modified time is never used: copies and
    syncing change it."""
    path = Path(path)
    if video:
        try:
            tags = video_tags(path)
        except Exception:  # an unreadable video is reported by the model check, not here
            tags = {}
        found = _iso_time(tags.get("com.apple.quicktime.creationdate"), wall_clock=True)
        if found:
            return found, "video metadata"
        if found := _name_time(path.name):
            return found, "file name"
        if found := _iso_time(tags.get("creation_time"), wall_clock=False):
            return found, "video metadata"
        return None, "none"
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            sub = exif.get_ifd(0x8769)
            for value in (sub.get(0x9003), sub.get(0x9004), exif.get(0x0132)):  # original, digitized, modified
                if found := _exif_time(value):
                    return found, "photo metadata"
    except Exception:  # unreadable photo: fall back to the name; the model check reports the error
        pass
    if found := _name_time(path.name):
        return found, "file name"
    return None, "none"


def window(plan: dict) -> tuple[datetime, datetime] | None:
    """[start, end) capture times for the plan's dates, or None when the request names no time."""
    if not plan["date_from"]:
        return None
    end = datetime.combine(plan["date_to"] + timedelta(days=1), time.min)
    return (datetime.combine(plan["date_from"], time.min),
            end + timedelta(hours=EVENT_NIGHT_HOURS) if plan["topic"] else end)


def far_by_name(name: str, span: tuple[datetime, datetime]) -> bool:
    """True when a OneDrive (UTC) file name shows the file was taken days away from the span."""
    m = ONEDRIVE_NAME.match(name)
    try:
        utc = datetime.strptime(m[1] + m[2], "%Y%m%d%H%M%S") if m else None
    except ValueError:
        return False
    if utc is None:
        return False
    local = _local(utc)
    return local < span[0] - NAME_MARGIN or local >= span[1] + NAME_MARGIN


# ---------- understanding the request ----------

def _nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    """n-th (1-based; -1 = last) given weekday of a month."""
    if n > 0:
        first = date(year, month, 1)
        return first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))
    last = date(year + month // 12, month % 12 + 1, 1) - timedelta(days=1)
    return last - timedelta(days=(last.weekday() - weekday) % 7)


def _easter(year: int) -> date:
    """Western Easter Sunday (anonymous Gregorian algorithm)."""
    a, b, c = year % 19, year // 100, year % 100
    d, e = b // 4, b % 4
    g = (8 * b + 13) // 25
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    return date(year, (h + l - 7 * m + 114) // 31, (h + l - 7 * m + 114) % 31 + 1)


HOLIDAYS = {
    "New Year's Day": lambda y: date(y, 1, 1), "Valentine's Day": lambda y: date(y, 2, 14), "Easter": _easter,
    "Mother's Day": lambda y: _nth_weekday(y, 5, 6, 2), "Memorial Day": lambda y: _nth_weekday(y, 5, 0, -1),
    "Father's Day": lambda y: _nth_weekday(y, 6, 6, 3), "Fourth of July": lambda y: date(y, 7, 4),
    "Labor Day": lambda y: _nth_weekday(y, 9, 0, 1), "Halloween": lambda y: date(y, 10, 31),
    "Thanksgiving": lambda y: _nth_weekday(y, 11, 3, 4), "Christmas Eve": lambda y: date(y, 12, 24),
    "Christmas": lambda y: date(y, 12, 25), "New Year's Eve": lambda y: date(y, 12, 31)}


def named_days(today: date) -> list[tuple[str, date, date]]:
    """Relative days and recent holidays worked out in code, so the model looks dates up instead of counting."""
    day = lambda d: (d, d)  # noqa: E731
    monday = today - timedelta(days=today.weekday())
    sunday_before = today - timedelta(days=(today.weekday() + 1) % 7 or 7)  # most recent Sunday before today
    first = today.replace(day=1)
    last_month_end = first - timedelta(days=1)
    names = [("today", *day(today)), ("yesterday", *day(today - timedelta(days=1))),
             ("this week (Monday to today)", monday, today),
             ("last week (Monday to Sunday)", monday - timedelta(days=7), monday - timedelta(days=1))]
    if today.weekday() >= 5:
        names.append(("this weekend", monday + timedelta(days=5), today))
    names.append(("last weekend", sunday_before - timedelta(days=1), sunday_before))
    names += [(f"last {WEEKDAYS[w]} (also \"on {WEEKDAYS[w]}\")",
               *day(today - timedelta(days=(today.weekday() - w) % 7 or 7))) for w in range(7)]
    names += [(f"the {WEEKDAYS[w]} before last (two {WEEKDAYS[w]}s ago)",
               *day(today - timedelta(days=((today.weekday() - w) % 7 or 7) + 7))) for w in range(7)]
    names += [("this month", first, today), ("last month", last_month_end.replace(day=1), last_month_end)]
    for name, when in HOLIDAYS.items():
        d = when(today.year)
        names.append((name, *day(d if d <= today else when(today.year - 1))))
    return names


def request_prompt(request: str, today: date) -> str:
    days = "\n".join(f"{d.isoformat()} {WEEKDAYS[d.weekday()]}{'  <- today' if d == today else ''}"
                     for d in (today - timedelta(days=n) for n in range(CALENDAR_DAYS - 1, -1, -1)))
    named = "\n".join(f"{name}: {a.isoformat()}" + (f" to {b.isoformat()}" if b != a else "")
                      for name, a, b in named_days(today))
    return (
        f"Today is {WEEKDAYS[today.weekday()]} {today.isoformat()}. The last {CALENDAR_DAYS} days:\n{days}\n\n"
        f"Named days, already worked out (holidays are the most recent ones):\n{named}\n\n"
        "A user wants to gather some of their photos and videos into one folder. Their request:\n"
        f"<<<{request.strip()}>>>\n\n"
        "Turn the request into JSON. First copy three parts of it, word for word (\"\" if it has none):\n"
        '- file_words: the words that say which kind of files, e.g. "photo and video", "pictures", "pics", '
        '"videos", "screenshots".\n'
        '- when_words: the words that say when, e.g. "on last Sunday", "from Halloween", "two Sundays ago", '
        '"in October", "from 11/1 to 11/3".\n'
        '- what_words: the words that say what the files show, e.g. "birthday party", "the beach", "Halloween '
        'party", "fireworks", "my dog", "screenshots", "receipts". Not the when_words, and not instructions such as '
        "sort, group, move or leave everything else. \"pictures from Halloween\" has only when_words (\"from "
        "Halloween\"); \"Halloween party\" has only what_words.\n"
        "Then:\n"
        '- topic: what_words as a short visual description in English, e.g. "a birthday party", "a beach", '
        '"food", "a screenshot", "a receipt", without names of people. "" if what_words is "".\n'
        '- media: from file_words: "photos" if they name only photos, pictures, pics, images or screenshots; '
        '"videos" if only videos or clips; otherwise "both" (both kinds, or no file_words).\n'
        '- date_from, date_to: the first and last day (YYYY-MM-DD) that when_words name; "" for both if '
        "when_words is \"\". One day: the same date twice. Copy named days from the list above (\"last Sunday\" "
        "and \"on Sunday\" are the most recent Sunday before today); count other days on the calendar. A month or "
        "season without a year is the most recent one that has started. Dates written like 11/8 are month/day.\n"
        "- people_named: names or relations of specific people in the request (e.g. \"Alice\", \"mom\"), else [].\n"
        '- folder_name: a 1-4 word title for the folder, without dates, e.g. "Birthday party".\n'
        "Reply with JSON only.")


PHOTO_WORD = re.compile(r"photo(?:graph)?s?|pictures?|pics?|images?|screenshots?|selfies?")
VIDEO_WORD = re.compile(r"videos?|clips?|movies?|footage|recordings?")
NEGATORS = {"no", "not", "without", "except", "excluding", "exclude", "but", "besides", "than", "minus"}


def _negates(word: str) -> bool:
    return word in NEGATORS or word.endswith("n't")


def media_from_words(request: str) -> tuple[str | None, bool]:
    """(media, certain) from the request's own words; the model sometimes misses "the snow photos". Certain when
    nothing is negated: one kind named, or both or neither. With not/except/no... it is a guess (a kind with a
    negating word just before it is unwanted) that the model's reading must confirm."""
    words = re.findall(r"[a-z]+(?:'t)?", request.lower().replace("\u2019", "'"))
    kinds = [(i, "photos" if PHOTO_WORD.fullmatch(w) else "videos") for i, w in enumerate(words)
             if PHOTO_WORD.fullmatch(w) or VIDEO_WORD.fullmatch(w)]
    wanted = {k for i, k in kinds if not any(_negates(w) for w in words[max(0, i - 3):i])}
    unwanted = {k for _, k in kinds} - wanted
    if not any(map(_negates, words)):
        return ("both" if len(wanted) != 1 else wanted.pop()), True
    if len(unwanted) == 1:
        return ({"photos", "videos"} - unwanted).pop(), False
    return (wanted.pop() if len(wanted) == 1 and not unwanted else None), False


def plan_request(readings: list[dict], request: str, today: date, overrides: dict | None = None) -> dict:
    """The plan for a request: the model's readings, with media taken from the request's words when they are
    plain, and refused when a negated request ("everything except videos") was read another way."""
    overrides = dict(overrides or {})
    media, certain = media_from_words(request)
    if certain and "media" not in overrides:
        overrides["media"] = media
    plan = agree(readings, today, overrides)
    if media and not certain and "media" not in overrides and plan["media"] != media:
        raise GroupError(f"the request could mean {plan['media']} or {media}; add --media {media} "
                         f"(or --media {plan['media']})")
    return plan


def _day(value: str, field: str) -> date | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise ValueError(f"model returned an invalid {field}: {value!r}") from e


def parse_request_reply(content: str, today: date) -> dict:
    data = json.loads(content)
    start, end = _day(data.get("date_from"), "date_from"), _day(data.get("date_to"), "date_to")
    if bool(start) != bool(end):
        start = end = start or end
    if start and start > end:
        start, end = end, start
    media = data.get("media") if data.get("media") in MEDIA else "both"
    people = [str(p).strip() for p in data.get("people_named") or [] if str(p).strip()]
    return {"topic": " ".join(str(data.get("topic") or "").split()), "media": media, "date_from": start,
            "date_to": end, "people": people, "folder_name": " ".join(str(data.get("folder_name") or "").split())}


def agree(readings: list[dict], today: date, overrides: dict | None = None) -> dict:
    """One plan from several readings of the same request. Fields given on the command line (overrides) replace
    the model's; the dates, media and whether there is a topic must then be the same in every reading."""
    if not readings:
        raise GroupError("the request could not be read")
    readings = [{**r, **(overrides or {})} for r in readings]
    keys = {(r["date_from"], r["date_to"], r["media"], bool(r["topic"])) for r in readings}
    if len(keys) > 1:
        options = "; ".join(f"{_dates_text(a, b)}, {m}, {'a topic' if t else 'no topic'}"
                            for a, b, m, t in sorted(keys, key=str))
        raise GroupError(f"the request was read in different ways ({options}). Reword it, or give the dates "
                         "with --from/--to (and --media)")
    plan = dict(readings[0])
    plan["topic"] = Counter(r["topic"] for r in readings).most_common(1)[0][0]
    plan["people"] = sorted({p for r in readings for p in r["people"]}, key=str.lower)
    if plan["date_from"] and plan["date_from"] > today:
        raise GroupError(f"the request points to future dates ({_dates_text(plan['date_from'], plan['date_to'])})")
    if plan["date_to"] and plan["date_to"] > today:
        plan["date_to"] = today
    if not plan["topic"] and not plan["date_from"]:
        raise GroupError("the request names neither what to look for nor when, e.g. "
                         '"birthday party last Sunday", "beach photos", or "videos from 10/31"')
    if plan["people"] and not plan["topic"]:
        raise GroupError(f"group cannot pick out specific people ({', '.join(plan['people'])}); describe what the "
                         "photos show instead, e.g. \"birthday party last Sunday\"")
    return plan


def _dates_text(start: date | None, end: date | None) -> str:
    if not start:
        return "any date"
    first = f"{WEEKDAYS[start.weekday()][:3]} {start.isoformat()}"
    return first if start == end else f"{first} to {WEEKDAYS[end.weekday()][:3]} {end.isoformat()}"


def dates_text(plan: dict) -> str:
    return _dates_text(plan["date_from"], plan["date_to"])


# ---------- checking a photo or video against the topic ----------

# Two wordings of the question, asked in this order; a file matches if either says yes (the second is asked only
# when the first says no). On public test photos each wording missed true matches that the other found, and
# neither added a false match: "shows" alone 20/22 birthday-party photos found, "taken at" alone 18/22, both 22/22.
MATCH_WORDINGS = ("shows", "taken at")


def match_prompt(topic: str, frames: int = 0, wording: str = "shows") -> str:
    if frames:
        subject, it = f"Here are {frames} frames, in time order, from one video in a personal camera roll. Does the video", "the video"
    else:
        subject, it = "Here is a photo from a personal camera roll. Does it", "the photo"
    if wording == "shows":
        ask = (f'show this: "{topic}"? Answer true only if {it} shows that itself, or something that identifies it. '
               "A different kind of event, place or thing, even a similar one, is false; so is anything you cannot "
               "tell.")
    else:
        ask = (f'show this: "{topic}", or was {it} clearly taken at one (for an occasion: its guests, food, '
               f"decorations or activities)? Answer false if {it} shows something else or you cannot tell.")
    return f"{subject} {ask} Give a confidence from 0 to 1. Reply with JSON only."


def parse_match(content: str) -> tuple[bool, float]:
    data = json.loads(content)
    if not isinstance(data.get("match"), bool):
        raise ValueError("model returned no true/false match")
    return data["match"], float(data.get("confidence") or 0.0)


# ---------- the group folder ----------

def folder_name(plan: dict, override: str | None, buckets) -> str:
    """Folder title (no slashes or other characters Windows refuses), with the dates unless --name is given;
    never the same as a bucket folder."""
    base = override or plan["folder_name"] or plan["topic"] or "Group"
    base = re.sub(r'[<>:"/\\|?*\x00-\x1f]', " ", base)
    base = " ".join(base.split()).strip(" .")[:60].strip(" .") or "Group"
    if not override and base[:1].islower():
        base = base[0].upper() + base[1:]
    if not override and plan["date_from"]:
        start, end = plan["date_from"], plan["date_to"]
        base += f" {start.isoformat()}" if start == end else f" {start.isoformat()} to {end.isoformat()}"
    if base.lower() in {b.lower() for b in buckets} or base.lower() in WINDOWS_RESERVED:
        base += " group"
    return base


def group_dirs(root: Path) -> set[Path]:
    """Group folders under root (any depth): they hold a GROUP_MARKER file."""
    return {p.parent.resolve() for p in Path(root).rglob(GROUP_MARKER)}


def write_marker(folder: Path, request: str, plan: dict, run_id: str) -> None:
    marker = folder / GROUP_MARKER
    if marker.exists():
        return
    marker.write_text(json.dumps({
        "note": "PhotoSort group folder: sort --recursive and later group runs leave its files here",
        "created": datetime.now().isoformat(timespec="seconds"), "run_id": run_id, "request": request,
        "topic": plan["topic"], "media": plan["media"],
        "dates": [d.isoformat() if d else None for d in (plan["date_from"], plan["date_to"])]}, indent=2),
        encoding="utf-8")
