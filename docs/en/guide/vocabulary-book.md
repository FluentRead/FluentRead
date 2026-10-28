# Learning center

Save words, phrases, and sentences from your reading. Understand them in context, try your own sentences, and review them later.

<GuideVisual kind="learning" en />

## Save something from a page

1. Open **Tools & learning → Learning center → Words & sentences** and enable saving in **Manage collection**.
2. Select text on a page, open its translation card, and use the save icon. **Save original** below an AI answer also saves the expression.
3. Return to **Words & sentences** and choose **Listen & understand** for a sentence or **Learn usage** for a word or phrase.

Saving keeps the selected text, available translation, context, and source. Saving it again can add context without creating a duplicate entry. Search original text, translations, explanations, or context. Use type and mastery filters to find items, or **Clear filters** to show everything.

Bilingual sentence highlighting helps compare original and translated text. Hovering does not show actions or start speech. To listen, copy, or save, select text and use its translation card. It saves your selection without expanding it to a whole paragraph. Private windows do not save collections.

## What each tab saves

| Tab | Content | Retention |
| --- | --- | --- |
| Words & sentences | Expressions you save, translations, and explanations | Until you delete them |
| Reading materials | Passages, question references, notes, and positions grouped by article, document, or video | Until cleared; removed materials can be restored |
| Reading history | Questions and answers from reading, grammar, usage, and practice, with follow-up questions | 30 days |
| Study notes | Notes saved from answers, or points and learning preferences you add | Until you delete them |

**Save original** and **Save study note** are separate actions. **Use study notes in answers** is off by default. Enable it in selection translation’s AI settings to send relevant notes and preferences with questions to your selected AI. Turning it off keeps existing notes and still allows saving new ones.

## Learn its usage

Opening a study page does not call AI or change mastery. Listen to the source sentence and expand saved reference content first. The page says when no useful source sentence is available.

1. Choose to understand the expression for its meaning, combinations, and an example. Without a source sentence, it explains general usage only.
2. Write your own sentence and ask whether it sounds natural. Feedback checks meaning and combinations without automatically marking mastery.
3. Add a short explanation manually, or save a generated explanation after it finishes. Stopped or failed output is not saved automatically.

AI explanations use the service, model, and context settings under **Selection translation → AI explanations**. Only deliberate actions send the current expression, your sentence, and permitted context or notes. They do not send the whole collection or source URL. Closing, switching entries, or changing models cancels the old request; failures can be retried.

Translations and explanations are saved separately. You can edit or clear an explanation. Each entry’s menu also offers copying, mastery, and deletion; entries with translations support bilingual copying. Retry speech if it fails.

## Revisit it later

Choose **Review** to recall an expression, reveal the answer, then rate whether you remembered it. Only this rating updates the review plan; reading an explanation does not increase mastery.

A round has up to 20 entries, with due items first and up to 10 new items. List filters do not change the round. A useful source sentence becomes a missing-expression prompt. Otherwise, recall the expression’s meaning and usage.

## Meet saved expressions on a new page

Enable **Meet saved expressions again** in **Manage collection**. It is off by default. Saved expressions in nearby text receive a dotted underline. Choose one or the bottom-right **Saved expressions** button to compare its current and saved sentences.

Opening the card reads local data only. **Explain this usage** uses selection AI settings to send the expression and permitted current sentence, without the old saved reference or source URL. Allow sentence context first if needed. Retry failures or stop while retaining generated text.

**Marking options** pauses this page visit or disables marks on all pages; re-enable them in the learning center. Seeing expressions, opening cards, or reading explanations does not change save counts, mastery, or review schedules.

This extension feature works on ordinary webpages, not private windows or userscripts. Links, editors, code, and similar content are excluded. Older browsers without text marking can still show nearby expressions from the bottom-right button.

## Continue with reading materials

Saved expressions, reading questions, and study notes appear in **Reading materials** by source. Same-name articles at different addresses remain separate. **Continue reading** returns to a passage, document page, or video time. If the passage cannot be located reliably, follow the guidance to search for it. Update changed addresses in material organization settings.

Choose **Add to learning materials** on a document page to save its file fingerprint and position. Select the original file again if its local record is missing. A same-name file with different content cannot replace it.

Add topics and personal notes to organize materials. Questions and study notes reference their original records; deleting the originals leaves no answer copy in materials. Questions still expire after 30 days.

Removing a material is reversible and keeps original saved expressions and questions. Clearing all materials permanently deletes organization, positions, and personal material notes. Materials stay local, are excluded from default settings sync, do not call AI when opened, and are unavailable in private windows.

Use the material manager’s separate export and restore actions. Its private JSON includes sources, passages, topics, and personal notes. Keep it safe; it is separate from collection and configuration backups.

Backups over 20 MiB are checked and staged in chunks on this device, then restored in one transaction. The current staging limits are 256 MiB for all material records and 128 MiB for one record. Keep the original materials and backup if storage is insufficient or the file exceeds these limits. If cancellation or disconnection leaves the result uncertain, check it or end the unfinished restore on the current page. After closing the page, this result can no longer be queried; check the material list first. Stopping the check does not confirm that the restore was cancelled or that staged data was deleted. Clearing all materials also deletes uncommitted staged content.

<span id="data-and-migration"></span>

## Keep your collection safe

Collections and review records stay in this browser. Disabling saving or clearing the translation cache does not delete them.

| What you need | Where to export |
| --- | --- |
| Filtered entries, translations, short explanations, and review records | **Manage collection → Export current list**; excludes context and source URLs |
| Full collection with context and sources | **Backup & restore** |
| Entries for Anki | Anki export in **Manage collection**, with optional source sentences and sources, plus a separate explanation column |
| Material organization, positions, and personal notes | The material manager’s separate backup |

Importing collection JSON merges with existing entries and reports added, updated, and skipped counts. Explanations merge by modification time, so an old file cannot replace newer explanations or restore cleared ones.

## Related guides

- [Selection and AI explanations](/en/guide/deepseek-harness)
- [Backup and sync](/en/config/backup-sync)
