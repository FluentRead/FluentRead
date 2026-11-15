/**
 * @file src/features/video-subtitle/modelFiles.ts
 * 文件职责：固定 FluentRead 浏览器内 Whisper 使用的模型仓库版本与精度文件清单。
 * 主要内容：给缓存完整性检查、设置页迁移和 Whisper Worker 下载提供同一组 Tiny/Base q4/q8 及 Small 混合精度文件名。
 * 模块边界：只声明模型文件身份，不读取存储、不访问网络，也不初始化识别运行时。
 */
import type {VideoLocalTranscriptionModel} from './transcription';

export const VIDEO_AI_MODEL_REVISION = 'master';

// Tiny/Base 的 q4、q8 pipeline 都需要这五个配置文件与两个精度对应的 ONNX 权重。
export const VIDEO_AI_Q4_MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_q4.onnx',
  'onnx/decoder_model_merged_q4.onnx',
] as const;
export const VIDEO_AI_Q8_MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
] as const;
/** Small 编码器保留 FP32；下载与识别 Worker 使用相同的混合精度清单。 */
export const VIDEO_AI_SMALL_MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model_merged_q4.onnx',
] as const;

export type VideoAiModelFile = typeof VIDEO_AI_Q4_MODEL_FILES[number]
  | typeof VIDEO_AI_Q8_MODEL_FILES[number]
  | typeof VIDEO_AI_SMALL_MODEL_FILES[number];

export function getVideoAiModelFileSets(model: VideoLocalTranscriptionModel): readonly (readonly VideoAiModelFile[])[] {
  if (model === 'small') return [VIDEO_AI_SMALL_MODEL_FILES];
  return [VIDEO_AI_Q4_MODEL_FILES, VIDEO_AI_Q8_MODEL_FILES];
}
