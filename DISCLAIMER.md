# Disclaimer

**For educational use only.** PhotoSort uses AI models and computer vision to sort, group, caption, search and
face-tag photos and videos. The results **may be inaccurate**. They depend on how each photo or video was captured
(lighting, focus, motion blur, resolution, angle, faces turned away or covered, compression), on the models you run,
and on your settings. Don't rely on it alone: **preview before moving files, keep a backup of your library, and
check results that matter yourself.**

1. **Educational and informational use only.** PhotoSort is a personal hobby project, not professional software or
   advice of any kind.
2. **AI results are estimates.** Buckets, group matches, dates read from requests, captions, search results, face
   matches and the people found by `faces-discover` come from AI models and may be wrong or incomplete. A video is
   judged from a few sampled frames, so content between those frames can be missed. Results can change with the
   model, its version and the machine that serves it.
3. **Face recognition can be wrong.** It can miss a person, match the wrong person or split one person in two. Never
   use it to identify people for security, legal, employment, law-enforcement or other decisions that affect them.
   Face data can be biometric data under the law where you live: you are responsible for having the right to
   process the faces of the people in your photos, and for respecting their privacy.
4. **It moves your files.** `sort`, `group` and `apply` move files by default, and `undo` moves them back from a
   journal. Errors, interruptions, cloud-sync conflicts, full disks or changes made by other programs can leave files
   misplaced or, in rare cases, lost. Use `--action report` to preview, keep backups, and check the result.
5. **Your setup, your responsibility.** PhotoSort sends model requests only to a local endpoint and refuses cloud
   models, but it cannot control the machines, models, network, router software or cloud storage you use. Keeping
   those secure, and choosing what is stored where, is up to you.
6. **Third-party software and models.** Models (for example `gemma4:12b`, `qwen3-embedding:8b` and InsightFace
   `buffalo_l`) and tools (NVIDIA PAIR, Ollama, InsightFace, PyAV/FFmpeg) come with their own licenses and terms.
   InsightFace's pretrained model weights are for non-commercial research use only. Review the terms before you use
   them, especially for anything commercial.
7. **Speeds are examples.** Measured speeds and accuracy figures come from one home setup and public test images;
   yours will differ.
8. **No warranty.** PhotoSort is provided "as is", without warranty of any kind, as stated in its
   [MIT license](LICENSE).
9. **Limitation of liability.** To the fullest extent permitted by law, the authors and contributors are not liable
   for any loss or damage, including lost, misplaced or mislabeled files, privacy harms, misidentification of people,
   or damage to equipment or property, arising from the use of, or reliance on, PhotoSort. You use it at your own
   risk.
10. **No affiliation.** Not affiliated with, endorsed or sponsored by NVIDIA, Google, Alibaba (Qwen), Ollama,
    InsightFace, Microsoft (OneDrive) or any other company named here. Trademarks belong to their owners.

---

*Maintainers:* the same text appears on the project page (`site\index.html`, `#disclaimer`). Keep both in sync.
