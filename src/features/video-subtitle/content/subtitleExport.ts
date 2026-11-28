/**
 * @file src/features/video-subtitle/content/subtitleExport.ts
 * 文件职责：把已确定的字幕时间轴序列化为 SRT、WebVTT 或可读 Markdown。
 * 主要内容：保留双语换行和原始毫秒范围，WebVTT 使用点分毫秒并转义正文标记，Markdown 按时间分段且转义富文本字符；同时给出文件扩展名与 MIME。
 * 模块边界：纯文本转换，不翻译、不补全缺失字幕、不下载文件；完整性、用户确认与媒体会话归属由 downloads 负责。
 */
import {serializeSrtCues, type VideoSubtitleCue} from './youtubeSubtitleData';

export type SubtitleExportFormat = 'srt' | 'vtt' | 'md';

export function serializeSubtitleFile(cues: readonly VideoSubtitleCue[], format: SubtitleExportFormat) {
    if (format === 'srt') return {text: serializeSrtCues(cues), extension: 'srt', mime: 'application/x-subrip;charset=utf-8'};
    const time = (value: number) => {
        const ms = Math.max(0, Math.round(value));
        return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
    };
    if (format === 'vtt') return {text: `WEBVTT\n\n${cues.map(cue => `${time(cue.startMs)} --> ${time(cue.startMs + cue.durationMs)}\n${cue.text.replace(/\r\n?/g, '\n').replace(/\n[ \t]*\n+/g, '\n').replace(/^\n+|\n+$/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n`).join('\n')}`, extension: 'vtt', mime: 'text/vtt;charset=utf-8'};
    return {text: cues.map(cue => `### ${time(cue.startMs)} – ${time(cue.startMs + cue.durationMs)}\n\n${cue.text.replace(/([\\`*_{}\[\]<>#!|])/g, '\\$1').replace(/\n/g, '  \n')}\n`).join('\n'), extension: 'md', mime: 'text/markdown;charset=utf-8'};
}
