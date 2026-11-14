/**
 * @file src/features/image-translation/services/textLayoutTypes.ts
 * 文件职责：声明图片与漫画排版共同使用的完整行布局和可选几何约束，避免绘制器与投影平面互相依赖。
 * 主要内容：实际墨迹高度、逐行基线、字号、行距，以及同源行距和完整候选适配端口。
 * 模块边界：仅含类型，不运行度量、绘制、像素观察或翻译；调用方须验证实际字形与原区域关系。
 */
export interface ImageTranslationTextLayout {
    lines:string[];
    fontSize:number;
    lineHeight:number;
    ink?:{height:number;baselines:number[]};
}

export interface ImageTextLayoutConstraints {
    sourceLineCount?:number;
    sourceLinePitch?:number;
    accept?:(layout:ImageTranslationTextLayout)=>boolean;
}
