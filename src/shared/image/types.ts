/**
 * @file src/shared/image/types.ts
 *
 * 文件职责：定义 OCR 图像识别结果的共享数据结构，使 worker、offscreen 和图片翻译 feature 使用一致行级坐标契约。
 * 主要内容：ImageViewport 与 OcrLine 描述可见范围、识别文本及 bounding box 等字段，只承载跨层传输所需类型，不包含识别执行、图像解码或 UI 渲染逻辑。 可核对的公开符号包括 OcrLine。
 * 模块边界：本文件属于 shared 小型公共层，仅提供无状态或低语义耦合的类型与工具；不读取 FluentRead 配置、不调用 provider、不注册入口或持有 feature 生命周期，使用者需自行处理业务政策。
 */

/** 漫画原图中实际可见的像素范围；这里只定义传输形状，绘制端按真实图片尺寸校验。 */
export interface ImageViewport {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** OCR 识别出的单行文本及其原图像素坐标。 */
export interface OcrLine {
    text: string;
    bbox: {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
    };
    /** 竖排文字区域：同一气泡的相邻竖列已按从右到左合并，绘制时不按细长列框的高度外扩留白。 */
    vertical?: true;
    /** 文档 OCR 的真实行基线与字高估计（原图像素）；不由当前行是否含下伸字母决定，用于稳定论文分段。 */
    baseline?: number;
    fontSize?: number;
    /** 文档中未通过局部复核的上下标原图区域；可以是无正文的核对提示框，不参与翻译。 */
    documentReview?: true;
}
