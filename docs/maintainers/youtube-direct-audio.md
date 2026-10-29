# YouTube 本地转写：受限直达音轨路径

这是最小、保守的独立音轨路径，**不代表 YouTube 全面支持，也尚未完成真实 YouTube 验收**。仅页面初始化脚本明确给出当前视频的完整直达音频地址时，播放器菜单才提供可启动的本地 AI 字幕入口。没有合格音源时继续使用既有原生字幕功能，不把 MSE/blob 复制或实时夺取播放器作为回退。

## 支持边界

- `youtube.com` / `www.youtube.com` / `m.youtube.com` 的 watch、shorts、embed 地址，11 字符视频身份与 `ytInitialPlayerResponse.videoDetails.videoId` 精确一致。
- 明确非直播、可播放，时长不超过 20 分钟；只选 `adaptiveFormats` 中直接 `url`、完整 `contentLength`、`approxDurationMs` 都明确的 AAC MP4 / Opus WebM 音频，最大 32 MiB。
- 仅识别明示默认音轨，或唯一可证实音轨。多个具名音轨没有唯一默认项、默认标记矛盾、身份缺失/混合、多个无身份音频格式均不支持；筛选时也计入 cipher/不支持编码的音轨，不能在过滤后把非默认配音误判成唯一音轨。播放器菜单明确提示：默认/唯一音轨不代表播放器当前选中的配音，改变原生配音选择不会改变本地识别音轨。不读取私有播放器 API。
- 仅 HTTPS `googlevideo.com` 或真实子域的 `/videoplayback`，拒绝用户信息、自定义端口、hash、range/sq/rn 分段参数。cipher、OTF、直播、未知时长/长度、旧 SPA 初始化脚本均不支持；不解签名、不请求私有接口。
- 独立 fetch 禁止重定向、不携带凭据或 referrer；要求 200、正确音频 MIME、完整精确长度、无 Content-Range。调用设置 30 秒超时预算（实际触发时间受浏览器调度影响）；输入字节和成功解码后的 PCM 结果受限，独立 AudioContext 校验时长、通道、采样率与有限 PCM，再转换为 16 kHz 单声道。`decodeAudioData` 在这些后置检查前即可原生分配内存：这里不保证浏览器解码内部内存硬上限，也不能保证取消原生解码。取消/超时仅停止等待、拒绝迟到结果并请求关闭上下文；关闭握手不阻塞识别，关闭失败输出一次固定、不含 URL 的警告，挂起的关闭握手并不等于已释放资源。
- 页面导航、广告、取消及卸载阻断迟到结果。失败只报告固定错误，不操作可见 video、CC 或 TextTrack，不扫描 clone、不使用麦克风。
- AI 有有效 cue 后取得整条时间轴所有权，晚到的原生 timedtext 不覆盖它；停止或失败清理自有字幕层并保留原生 CC 状态。广告期间不显示或生成内容字幕。
- 缓存消息只包含规范 `https://www.youtube.com/embed/<videoId>` 身份，不含签名音频 URL。当前不自动或主动恢复 YouTube 识别缓存，避免把尚未确认的缓存轨道置于原生轨道之前；完整识别结果仍按既有有界缓存策略写入。

UI 轮询只保存当前 video ID、播放器及媒体实例的单个资格结果（包括不支持），不保存音轨 URL；导航、媒体替换和销毁清除。页面脚本较晚就绪时，重新打开 FluentRead 播放器菜单会重新检查，周期 UI 同步不会反复解析初始化脚本。点击生成和实际音频读取仍重新发现并校验音轨，缓存资格不能绕过广告或身份检查。

## 已验证与未验证

确定性单测使用合成元数据、模拟网络与 AudioContext；runtime 测试挂载真实生产模块和 DOM，用 mock 模型验证成功接线、原生/AI 仲裁、拒绝和取消，不调用真实模型或付费服务。新增三个模块纳入严格四维覆盖清单。

```bash
pnpm test tests/youtubeDirectAudio.test.ts tests/videoSubtitleTrackPriorityRuntime.test.ts tests/videoTranscriptionCacheClient.test.ts
pnpm test:audit
pnpm compile
```

这不证明真实 YouTube 页面一定提供直达音轨、不证明 CORS/签名有效期/编解码器支持，也不证明真实本地模型识别质量。当前环境没有取得可验证的真实 YouTube 音轨与生产扩展浏览器验收证据；主目标仍须按这些边界报告“未完成真实站点验收”，不得用离线夹具通过代替。浏览器隔离世界、后台及 Firefox 运行时诊断也未由 Node DOM 回归覆盖。
