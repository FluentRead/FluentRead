# Learning center

Turn everyday reading into lasting vocabulary: save words and sentences with context, practice with AI feedback, review on a spaced schedule, and re-encounter saved expressions automatically on new webpages.

For offline dictionaries, custom lookup APIs, and card templates, see [Dictionaries & study cards](/en/guide/dictionaries).

<GuideVisual kind="learning" en />

<DocDiagram kind="learning-loop" en />

## Step 1: Save while reading {#save-while-reading}

1. Open **Tools & learning → Learning center → Words & sentences** and enable saving under **Manage saved items**.
2. Select text in webpages, PDFs, or video captions and click the save icon in the selection card (or **Save original** below an AI explanation).
3. Return to **Words & sentences** and open **Listen & understand** (sentences) or **Study usage** (words & phrases).

- **Deduplication & search:** Saving an existing item enriches its context instead of duplicating it; search across source, translation, notes, and context, or filter by type and mastery.
- **Privacy:** Private/incognito windows never write saved items or history.

## Step 2: Understand, practice & review {#understand-and-use}

Opening the study view never calls AI or alters mastery automatically:

1. **Listen & understand:** Play original audio, then click **Understand this expression** on demand for meanings, collocations, and examples.
2. **Write your own sentence:** Draft a sentence under **Try using it yourself** and click **Check if it sounds natural** for feedback (feedback never auto-marks mastery).
3. **Save concise notes:** Add a manual note or click **Save this explanation** after generation finishes.
4. **Spaced recall review:** Click **Review N items** (up to 20 per round: due items first, plus up to 10 new items). Recall before revealing the answer; only grading **Remembered** or **Forgot** updates your schedule.

::: info AI privacy scope
Study actions reuse your **Selection translation → AI explanations** provider and send only the current item, your practice sentence, and permitted context/notes—never your full vocabulary book or source URLs.
:::

## Step 3: Re-encounter on new webpages {#re-encounter-saved-expressions}

Enable **Re-encounter saved expressions** (off by default) under **Manage saved items**:

- Saved expressions appearing in new articles receive subtle dotted underlines (links, code, and inputs are skipped).
- Click the underlined phrase or the bottom-right **Re-encounter** badge to compare the current sentence with your saved original (local lookup only; AI runs only if you click **Understand current usage**).
- Viewing re-encounters never modifies mastery or review intervals; pause for the current page or disable globally anytime via **Marker options** (desktop extension regular tabs only).

## Step 4: Organize by reading materials {#continue-with-reading-materials}

Saved items, Q&A threads, and notes automatically group by source under **Reading materials**, and documents can join via **Add to learning materials**:

- Click **Continue reading** to jump straight back to the article sentence, document page, or video timestamp.
- **Remove** is reversible and keeps underlying vocabulary items; **Clear all materials** permanently deletes material groups, positions, and material notes.
- Materials stay local (excluded from default cloud sync) and have their own **Export / Restore material backup** workflow (backups >20 MiB stage and verify in chunks up to 128 MiB per item).

## Data export & Anki migration {#data-and-migration}

Disabling the save button or clearing the translation cache **never** deletes your saved items or review history:

| What you need | Where to export |
| --- | --- |
| **Current filtered list** | **Manage saved items → Export current list** (excludes context & source URLs) |
| **Import into Anki** | **Manage saved items → Export to Anki** (optional context & source; notes in a dedicated column) |
| **Full collection with context** | [Local full backup](/en/config/backup-sync#local-full-backup) with **Include word context** checked |
| **Materials, positions & notes** | **Reading materials → Export / Restore material backup** |

**Import saved items** merges JSON safely without wiping existing entries and keeps newer edited notes by timestamp.

## Related guides

- [Dictionaries & study cards](/en/guide/dictionaries)
- [Selection translation & AI explanations](/en/guide/deepseek-harness)
- [Backup & sync](/en/config/backup-sync)
