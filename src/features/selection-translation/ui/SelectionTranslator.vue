<!--
 * @file src/features/selection-translation/ui/SelectionTranslator.vue
 * 来源提交：翻译与词典异步结果交付前复核已克隆选区的正文、连接和适配器边界，不依赖原生高亮仍然存在；来源失效时撤销旧卡片，词书保存仍保留失联上下文回退。
 * 两点选取：默认关闭及文档适配器跳过快捷键冲突计算，快捷键开启单次起终点选择并放行开放 Shadow DOM 编辑区；复用原生选区与现有划词入口，完成后的首次选区读取保留同轮延迟滚动，随后恢复普通滚动收起，取消、编辑与卸载撤销首帧保护；短状态提示不捕获页面指针，未命中文字或起终点重合时说明可继续操作，配置变更和卸载释放控制器。
 * 通知布局：收藏与语音设置通知沿用安全可见视口订阅，触摸动作保留完整命中区；通知不增加独立监听或请求。
 * 极矮视口：同一卡片改为整卡滚动并收紧顶栏间距，保留输入与请求、手动几何和语音状态；Safari 键盘视口变化后仅在当前有限窗口内滚动卡片自身显露原聚焦输入，主动操作取消待处理显露；恢复尺寸后沿用原定位，不增加监听或计时器。
 * 文件职责：实现划词翻译的主要页面组件，覆盖选区捕获、触摸原生句柄稳定等待、避开原生菜单上下区域的行侧入口、可见视口与安全区定位、后台及宿主恢复来源校验、图标/小点/悬停/快捷键/仅右键菜单/直接弹出、原生菜单可信选区恢复与重复请求复用、翻译与词卡展示、免费 AI 讲解的显式启用、朗读、收藏选中的单词/表达/句子、双语分享卡片、鉴权服务配置入口、重试和关闭。
 * 主要内容：相同译文保留原文且不重复展示；Firefox 触摸入口为原生手柄保留独立侧距，以绑定来源快照的可信触摸处理缺少 click 的情况并取消拖动；Safari/Firefox 触摸入口成功开卡后保留当前快照并清空同一原生选区，异步空选区不误关卡片；组件管理可信手势、已关闭选区与选择丢失宽限、继续阅读或复制原文时自动收起、请求 token、按既有错误种类显示有限提示并仅为当前鉴权失败提供通用设置入口、行内代码保护与纯文本安全渲染、按标签页页面缩放补偿的弹窗定位、空白拖动、边角缩放、主题及可换行的多语言标题；普通译文先于完整原文，单行可横向滚动的导航与右侧固定分享、收藏、关闭及更多操作把高度留给正文，次级菜单按可见窗口覆盖显示；指针移动按帧合并并在结束时提交最后位置，已定位卡片不重复读取选区几何；富文本 UTF-16 跟读偏移一次计算并复用；默认过滤同语言选区，按配置开放中英反向入口，翻译方向始终按现有语言配置判断；统一卡片默认显示翻译并以同一导航进入学习；首次定位后保持弹窗锚点，手动尺寸下内容与播放状态变化只影响内部布局；闲置语音栏不占空间，自动卡生成与播放期间按底栏实际高度自然增高，达到视口上限后正文独立滚动；学习短回答自然收拢、长回答受高度上限约束，完整原文和译文按需对照并允许翻译继续完成；单词先展示原文与可用词卡，再补充辅助释义，以紧凑状态提示等待、未命中与网络失败；关闭或更换选区取消等待并阻止旧响应覆盖新结果；区分语音生成和播放，按实际音频时钟或浏览器词边界显示完整词高亮，并提供真实音频时间与前后 5 秒跳转。
 * 材料关联：主动收藏与阅读时捕获当前选区的稳定来源和文本位置，词书真实保存后才关联材料引用，隐私窗口不采集。
 * 语音边界：单词朗读在仅本地模式下跳过词典外部音频，由既有后台本地语音链路处理失败与模型提示。
 * 模块边界：组件只通过公共客户端和 runtime 消息触达后台及现有设置入口，不直接持有 provider、IndexedDB 或 Offscreen 资源；纯选区算法在 core，活动 Range 通过回调交给 content/runtime 管理 modal 挂载所有权；扩展 PDF 文档页通过可选来源适配器复用同一卡片、标题和阅读上下文，来源失效时取消当前请求，词书协议独立维护；Safari 仅为可信聚焦的同一追问框、卡片和原文保留初次键盘缩高或明确旋转后的有限宿主页平移窗口，明确方向先于可见视口宽度更新时也保留该固定窗口，宽度追上不续期；极矮可滚动卡片内的可信纵向触摸另有不续期的400ms尾窗，只容许累计2px宿主页偏移，不拦截原生滚动；输入与框内编辑键结束当前窗口，外部手势、缩放、失焦与关闭撤销身份，普通滚动仍收卡；阅读依据的 DOM 锚点只属于当前选区，关闭、换区或卸载释放临时绘制和监听。
 -->
<template>
  <div v-ui-i18n v-show="showIndicator || showTooltip || noticeMessage || copySuccess || clickSelectionState !== 'idle'" class="fr-selection-translator-root" :class="{'fr-touch-selection': touchInteraction}" :data-display-delay="selectionSettings.delay" @pointerdown.capture="dismissReadingToolsOutside" @pointerdown.stop @focusin="handleReadingInputFocus" @focusout="dismissReadingToolsOnFocusOut" @input="clearReadingKeyboardFocus" @wheel.stop="handleUiWheel">
    <div v-if="clickSelectionState !== 'idle'" class="fr-click-selection-hint" :data-click-selection-state="clickSelectionState" :class="{'fr-click-selection-hint--dark': isDarkTheme}" role="status" aria-live="polite">{{ clickSelectionNotice || (clickSelectionState === 'start' ? '点击文字起点' : '点击文字终点') }} · Esc 取消</div>
    <button v-if="showIndicator && !showTooltip && triggerMode !== 'contextMenu'" class="fr-selection-indicator" :class="`fr-selection-indicator--${triggerMode}`" :style="indicatorStyle" type="button" aria-label="打开划词翻译" title="打开划词翻译" @pointerdown.prevent.stop="beginIndicatorTouch" @pointermove="trackIndicatorTouch" @pointerup="finishIndicatorTouch" @pointercancel="cancelIndicatorTouch" @contextmenu="cancelIndicatorTouch" @pointerenter="scheduleIndicatorHover" @pointerleave="leaveIndicator" @click="openTooltipFromIndicator">
      <span class="fr-selection-indicator-glyph" aria-hidden="true">译</span>
    </button>

    <section v-if="showTooltip" ref="tooltip-ref" class="fr-translation-tooltip" :class="{ 'fr-dark-theme': isDarkTheme, 'fr-reading-tooltip': readingMode, 'fr-popup-manipulating': popupManipulating, 'fr-short-viewport': isShortViewport() }" :data-placement="popupPlacement" :style="[tooltipScaleStyle, tooltipStyle]" role="dialog" aria-label="划词翻译结果" data-presentation="card" @pointerdown.stop="beginPopupGesture" @pointermove="movePopupGesture" @pointerup="stopPopupGesture" @pointercancel="stopPopupGesture" @lostpointercapture="stopPopupGesture">
      <div class="fr-study-navigation">
        <img class="fr-tooltip-brand-icon" :src="selectionTranslatorIconUrl" alt="" aria-hidden="true" draggable="false" />
        <div class="fr-study-toolbar" role="group" aria-label="划词卡片内容" :title="isWordSelection ? '词典释义 · 按词性分类' : '先看译文，按需深入'" @focusin="handleStudyToolbarFocus">
          <button type="button" :aria-pressed="!readingMode" @click="openTooltip()">翻译</button>
          <template v-if="readingEnabled">
            <button v-for="action in readingActions" :key="action.id" type="button" :title="action.description" :aria-pressed="readingMode && !readingHistoryOnly && readingInitialAction === action.id" @click="openReading(action.id)">{{ action.id === 'grammar' ? '词性与句法' : action.label }}</button>
            <button v-if="!isPrivateContext" type="button" :aria-pressed="readingMode && readingHistoryOnly" @click="openReadingHistory">记录</button>
          </template>
          <button v-else-if="canEnableFreeReading || freeReadingPending" type="button" :disabled="freeReadingPending" title="B站免费基础读懂/用法，无需 API Key；完整语法、练习和追问可切换 AI 服务" @click="enableFreeReading">{{ freeReadingPending ? '正在启用…' : '免费 AI 讲解' }}</button>
          <button v-else type="button" @click="openSelectionSettings">配置 AI 讲解</button>
        </div>
        <div ref="reading-tools-target" v-show="readingMode && !readingHistoryOnly" class="fr-study-reading-tools" />
        <div class="fr-tooltip-actions">
          <button v-if="!readingMode && shareCardAvailable && translationResult && !isLoading" class="fr-action-btn fr-share-card-entry" type="button" :title="t('shareCard.create')" :aria-label="t('shareCard.create')" @click="openShareCard({original: selectedText, translation: translationResult})"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" /></svg></button>
          <button
            v-if="!readingMode && config.vocabularyBookEnabled && selectedText && !isPrivateContext"
            class="fr-action-btn fr-vocabulary-btn"
            :class="{ 'fr-saved': isVocabularySaved }"
            type="button"
            :disabled="vocabularyBusy || !vocabularyAnswer"
            :title="vocabularyButtonTitle"
            :aria-label="vocabularyButtonTitle"
            :aria-pressed="isVocabularySaved"
            @click="saveVocabularyEntry"
          ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.7 2.86 5.8 6.4.93-4.63 4.51 1.09 6.38L12 17.3l-5.72 3.02 1.09-6.38-4.63-4.51 6.4-.93L12 2.7Z" /></svg></button>
          <button class="fr-close-btn" type="button" title="关闭" aria-label="关闭翻译结果" @click="closeTooltip">×</button>
        </div>
      </div>
      <div v-if="readingSelection" v-show="readingMode" class="fr-tooltip-content fr-reading-content">
        <ReadingPanel ref="reading-panel-ref" :external-navigation="true" :tools-target="readingToolsTarget" @view-change="syncReadingView" :selection="readingSelection" :locate-evidence="locateReadingEvidence" :clear-evidence="clearReadingEvidence" :source-revision="readingSourceRevision" :check-evidence="checkReadingEvidence" :source-translation="{source: selectedText, text: translationResult, pending: isLoading, error}" :preferences="readingPreferences" :service="readingService" :active="readingMode" :initial-action="readingInitialAction" :history-only="readingHistoryOnly" :source-language="effectiveSourceLanguage" :target-language="effectiveTargetLanguage" :playing-source-text="isPlaying && currentAudioKind === 'source' ? currentAudioText : ''" :model-revision="readingModelRevision" :vocabulary-enabled="config.vocabularyBookEnabled" :private-context="isPrivateContext" :animations="config.animations" @play-source="toggleAudio($event, 'source')" @source-change="stopAudio()" @resize="schedulePositionUpdate" />
      </div>
      <div v-show="!readingMode" class="fr-tooltip-content" aria-live="polite">
        <div v-if="isLoading && !translationResult && !wordCard && !wordCardError && !isWordSelection" class="fr-loading-state"><span :class="['fr-loading-spinner', { 'fr-static': !config.animations }]" aria-hidden="true" /><span>正在查询…</span></div>
        <div v-else-if="error && !translationResult && !wordCard" class="fr-error-state"><span>{{ error }}</span><span class="fr-error-actions"><button type="button" @click="retryTranslation">重试</button><button v-if="isAuthenticationErrorCurrent(authenticationError)" type="button" :disabled="!!openingAuthenticationSettings" @click="openAuthenticationSettings">{{ translateLegacy('配置服务') }}</button></span></div>
        <div v-else class="fr-translation-container">
          <section v-if="isWordSelection && (wordCard || isWordCardLoading)" class="fr-word-learning-card" aria-label="单词学习卡">
            <div v-if="isWordCardLoading && !wordCard" class="fr-word-card-loading" role="status"><span :class="['fr-loading-spinner', { 'fr-static': !config.animations }]" aria-hidden="true" /><span>{{ hasDistinctTranslationResult ? '译文已显示，正在补充词典…' : '正在查询词典，译文会先显示…' }}</span></div>
            <template v-else-if="wordCard">
              <div class="fr-word-heading">
                <div>
                  <h3><SpeechFollowText :text="selectedText" :offset="0" :progress="audioProgressFor('word')" /></h3>
                  <span class="fr-word-normalized" v-if="selectedText.toLowerCase() !== wordCard.normalizedWord">词典词形：{{ wordCard.word }}</span>
                </div>
                <div class="fr-word-heading-actions">
                  <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('source') }" data-copy-kind="source" type="button" :title="copyButtonTitle('source')" :aria-label="copyButtonTitle('source')" @click="copyText(selectedText, 'source')">
                    <svg v-if="isCopied('source')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    <span>{{ isCopied('source') ? '已复制' : '复制' }}</span>
                  </button>
                  <button v-if="wordCard.phonetics.length === 0" class="fr-text-audio-btn fr-word-heading-audio" type="button" :aria-label="wordAudioLabel({ text: wordCard.word })" :title="wordAudioLabel({ text: wordCard.word })" @click="toggleWordAudio({ text: wordCard.word })">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                  </button>
                </div>
              </div>
              <div v-if="wordCard.phonetics.length > 0" class="fr-word-pronunciations" aria-label="发音">
                <div v-for="(pronunciation, index) in wordCard.phonetics.slice(0, 4)" :key="`${pronunciation.text || ''}-${pronunciation.audio || ''}-${index}`" class="fr-word-pronunciation">
                  <span class="fr-word-pronunciation-label">{{ pronunciation.label || (index === 0 ? '发音' : '变体') }}</span>
                  <span class="fr-word-ipa">{{ pronunciation.text || '点击播放' }}</span>
                  <button class="fr-text-audio-btn" type="button" :aria-label="wordAudioLabel(pronunciation)" :title="wordAudioLabel(pronunciation)" @click="toggleWordAudio(pronunciation)">
                    <svg v-if="isCurrentWordAudio(pronunciation)" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" /></svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                  </button>
                </div>
              </div>
              <div v-if="hasDistinctTranslationResult" class="fr-word-translation">
                <div class="fr-word-translation-header">
                  <span class="fr-text-label">译文</span>
                  <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('translation') }" data-copy-kind="translation" type="button" :title="copyButtonTitle('translation')" :aria-label="copyButtonTitle('translation')" @click="copyText(translationResult, 'translation')">
                    <svg v-if="isCopied('translation')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                    <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                    <span>{{ isCopied('translation') ? '已复制' : '复制' }}</span>
                  </button>
                </div>
                <pre><template v-for="(part, index) in translatedTextParts" :key="index"><code v-if="part.kind === 'code'" class="fr-inline-code">{{ part.text }}</code><SpeechFollowText v-else :text="part.text" :offset="part.offset" :progress="translationAudioProgress" /></template></pre>
              </div>
              <div v-else-if="isLoading" class="fr-word-translation-loading">正在翻译释义…</div>
              <div v-if="wordCard.meanings.length > 0" class="fr-word-meaning-toolbar">
                <span>英文释义 · 中文辅助</span>
                <button type="button" @click="showChineseSupport = !showChineseSupport">{{ showChineseSupport ? '隐藏中文辅助' : '显示中文辅助' }}</button>
              </div>
              <div v-if="isWordCardSupportLoading" class="fr-word-support-loading" role="status">正在补充辅助释义…</div>
              <div v-if="wordCard.meanings.length > 0" class="fr-word-meanings">
                <div v-for="meaning in wordCard.meanings.slice(0, 4)" :key="meaning.partOfSpeech" class="fr-word-meaning">
                  <strong class="fr-pos-label" :title="translateLegacy(describePartOfSpeech(meaning.partOfSpeech).description)">{{ translateLegacy(meaning.partOfSpeech) }}</strong>
                  <ol>
                    <li v-for="definition in meaning.definitions.slice(0, 4)" :key="`${meaning.partOfSpeech}-${definition.definition}`">
                      <span class="fr-word-definition-en">{{ definition.definition }}</span>
                      <span v-if="showChineseSupport && definition.translatedDefinition && definition.translatedDefinition !== definition.definition" class="fr-word-definition-zh">{{ definition.translatedDefinition }}</span>
                      <em v-if="definition.example">
                        <span class="fr-word-example-en">例句：{{ definition.example }}</span>
                        <span v-if="showChineseSupport && definition.translatedExample && definition.translatedExample !== definition.example" class="fr-word-example-zh">译：{{ definition.translatedExample }}</span>
                      </em>
                    </li>
                  </ol>
                </div>
              </div>
              <div v-else class="fr-word-empty">暂未找到详细释义，可查看译文。</div>
              <footer class="fr-word-card-footer">
                <span>数据来自开放词典</span>
                <a v-for="source in wordCard.sources" :key="source.id" :href="source.url" target="_blank" rel="noreferrer">{{ source.label }}</a>
              </footer>
            </template>
          </section>
          <div v-if="isWordSelection && wordCardError" class="fr-word-fallback-note" role="status"><span>{{ wordCardError }}</span><button type="button" @click="retryWordCard">重查词典</button></div>
          <div v-if="(selectionSettings.mode === 'bilingual' || selectionSettings.mode === 'translation-only') && hasDistinctTranslationResult && !isWordCardVisible" class="fr-text-block fr-translation-result">
            <div class="fr-text-block-header">
              <span class="fr-text-label">译文</span>
              <div class="fr-text-actions">
                <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('translation') }" data-copy-kind="translation" type="button" :title="copyButtonTitle('translation')" :aria-label="copyButtonTitle('translation')" @click="copyText(translationResult, 'translation')">
                  <svg v-if="isCopied('translation')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  <span>{{ isCopied('translation') ? '已复制' : '复制' }}</span>
                </button>
                <button class="fr-text-audio-btn" type="button" :aria-label="audioLabel('translation')" :title="audioLabel('translation')" @click="toggleAudio(translationResult, 'translation')">
                  <svg v-if="isCurrentAudio('translation')" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                </button>
              </div>
            </div>
            <pre><template v-for="(part, index) in translatedTextParts" :key="index"><code v-if="part.kind === 'code'" class="fr-inline-code">{{ part.text }}</code><SpeechFollowText v-else :text="part.text" :offset="part.offset" :progress="translationAudioProgress" /></template></pre>
          </div>
          <div v-if="(selectionSettings.mode === 'bilingual' || (translationResult && !hasDistinctTranslationResult)) && !isWordCardVisible" class="fr-text-block fr-original-text">
            <div class="fr-text-block-header">
              <span class="fr-text-label">原文</span>
              <div class="fr-text-actions">
                <button class="fr-text-copy-btn" :class="{ 'fr-copied': isCopied('source') }" data-copy-kind="source" type="button" :title="copyButtonTitle('source')" :aria-label="copyButtonTitle('source')" @click="copyText(selectedText, 'source')">
                  <svg v-if="isCopied('source')" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                  <span>{{ isCopied('source') ? '已复制' : '复制' }}</span>
                </button>
                <button class="fr-text-audio-btn" type="button" :aria-label="audioLabel('source')" :title="audioLabel('source')" @click="toggleAudio(selectedText, 'source')">
                  <svg v-if="isCurrentAudio('source')" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6v12M16 6v12" /></svg>
                  <svg v-else viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Z" /><path d="M16 9.5a4.5 4.5 0 0 1 0 5M18.5 7a8 8 0 0 1 0 10" /></svg>
                </button>
              </div>
            </div>
            <pre><template v-for="(part, index) in sourceTextParts" :key="index"><code v-if="part.kind === 'code'" class="fr-inline-code">{{ part.text }}</code><SpeechFollowText v-else :text="part.text" :offset="part.offset" :progress="sourceAudioProgress" /></template></pre>
          </div>
          <div v-if="error && (translationResult || wordCard)" class="fr-inline-error"><span>{{ error }}</span><span class="fr-error-actions"><button type="button" @click="retryTranslation">重试</button><button v-if="isAuthenticationErrorCurrent(authenticationError)" type="button" :disabled="!!openingAuthenticationSettings" @click="openAuthenticationSettings">{{ translateLegacy('配置服务') }}</button></span></div>
        </div>
      </div>
      <div class="fr-playing-status" :class="{'is-idle': !isPlaying && !isPreparingAudio}" :aria-hidden="!isPlaying && !isPreparingAudio" :aria-busy="isPreparingAudio" role="status">
        <template v-if="isPlaying || isPreparingAudio">
          <span class="fr-playing-label"><template v-if="isPreparingAudio">正在生成语音…</template><template v-else>正在播放{{ currentAudioKind === 'source' ? '原文' : currentAudioKind === 'word' ? '单词' : '译文' }}</template></span>
          <div class="fr-playback-controls">
            <span v-if="audioPosition && !isPreparingAudio" class="fr-playback-time" aria-hidden="true">{{ playbackTime(audioPosition.currentTime) }} / {{ playbackTime(audioPosition.duration) }}</span>
            <template v-if="isPlaying && !isPreparingAudio">
              <button v-for="control in seekControls" :key="control.offset" class="fr-seek-btn" type="button" :aria-label="control.label" :title="audioPosition ? control.label : '当前语音不支持按秒跳转'" :disabled="!audioPosition || (control.offset < 0 ? audioPosition.currentTime <= 0 : audioPosition.currentTime >= audioPosition.duration)" @click="seekAudio(control.offset)"><svg viewBox="0 0 24 24" aria-hidden="true"><path :d="control.offset < 0 ? 'M4 9a8 8 0 1 1 0 7M4 4v5h5' : 'M20 9a8 8 0 1 0 0 7M20 4v5h-5'" /><text x="12" y="16">5</text></svg></button>
            </template>
            <button type="button" :aria-label="isPreparingAudio ? '停止生成语音' : '停止播放'" :title="isPreparingAudio ? '停止生成语音' : '停止播放'" @click="stopAudioFromUi">停止</button>
          </div>
        </template>
      </div>
      <div v-for="edge in popupResizeEdges" :key="edge" class="fr-popup-resize-handle" :class="`fr-popup-resize-${edge}`" :data-resize-edge="edge" aria-hidden="true" />
    </section>

    <div v-if="noticeMessage" class="fr-action-toast" :class="{ 'fr-dark-theme': isDarkTheme }" :style="noticeViewportStyle" role="status"><span>{{ noticeMessage }}</span><button v-if="noticeAction === 'open-vocabulary'" type="button" @click="openNoticeSettings">查看</button><button v-else-if="noticeAction === 'open-local-tts'" type="button" @click="openNoticeSettings">设置</button></div>
    <div v-else-if="copySuccess" class="fr-copy-success-toast" :class="{ 'fr-dark-theme': isDarkTheme }" role="status">{{ copySuccessMessage }}</div>
  </div>
</template>

<script setup lang="ts">
import {audioSpeechProgress, boundarySpeechProgress, parseSpeechCues, parseSpeechProgress, parseSpeechPlaybackPosition, seekSpeechTime, type SpeechProgress, type SpeechPlaybackPosition, type SpeechCue} from '@/src/core/tts/speechProgress';
import SpeechFollowText from './SpeechFollowText.vue';
import {hasDistinctTranslation} from '@/src/core/translation/result';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef, watch } from 'vue';
import browser from 'webextension-polyfill';
import {addRuntimeMessageListener} from '@/src/platform/browser/runtimeMessages';
import {getSafeVisualViewportRect, observeVisualViewport} from '@/src/platform/dom/visualViewport';
import {openShareCard, isShareCardMounted} from '@/src/features/share-card/public';
import {createClickSelectionController} from '@/src/features/selection-translation/content/clickSelection';
import {findClickSelectionHotkeyConflict, isClickSelectionAvailable, matchesClickSelectionShortcut} from '@/src/core/config/clickSelection';
import { config, configReady, requestConfigPatch, subscribeConfig } from '@/src/services/config/store';
import { translateText, translateTextBatch } from '@/src/services/translation/client';
import {serializeTranslationError} from '@/src/services/translation/errors';
import {detectlang, shouldSkipChineseSelection, shouldSkipTranslationForTarget} from '@/src/core/language/detect';
import { matchesConfiguredHotkey, matchesModifierOnlyHotkey, resolveConfiguredHotkey } from '@/src/core/hotkey';
import {describePartOfSpeech} from '@/src/core/language/partOfSpeech';
import type { WordCardData, WordPronunciation } from '@/src/features/selection-translation/services/wordDictionary';
import { isSingleEnglishWord, normalizeEnglishWord } from '@/src/features/selection-translation/services/wordNormalization';
import { calculateSelectionPopupPosition, chooseSelectionRect, getSelectionPresentationDelayRemaining, readSelectionParts, translateSelectionParts, normalizeSpeechLanguage, reconcileSelectionPresentation, resolveSelectionDictionaryFallback, resolveSelectionVocabularyAnswer, selectionReverseTarget, SelectionRequestTokenGate, shouldIgnoreSelection, summarizeSelectionContext, type SelectionAnswerCandidate, type SelectionContentRequest, type SelectionRect, type SelectionTextPart } from '@/src/features/selection-translation/core';
import {
  createSelectionTtsClientRequestId,
} from '@/src/features/selection-translation/protocol';
import { createSelectionTtsContentController } from '@/src/features/selection-translation/content/selectionTtsContentController';
import { setSelectionContextMenuHandler } from '@/src/features/selection-translation/content/contextMenuBridge';
import {normalizeSelectionPageZoom, SELECTION_PAGE_ZOOM_CHANGED, SELECTION_PAGE_ZOOM_REQUEST} from '@/src/features/selection-translation/pageZoom';
import { VOCABULARY_BOOK_CHANGED_MESSAGE, VOCABULARY_BOOK_MESSAGE, type VocabularyBookResponse } from '@/src/features/vocabulary/protocol';
import {ReadingPanel} from '@/src/features/reading-assistant/ui/panel/public';
import {captureReadingSelection, createReadingEvidenceAnchor, type ReadingEvidenceAnchor, type ReadingSelection} from '@/src/features/reading-assistant/public';
import {captureMaterialSelection, beginMaterialCapture, completeMaterialCapture} from '@/src/features/vocabulary/material/public';
import {projectMaterialOriginalText} from '@/src/features/vocabulary/material/text/public';
import {HARNESS_ACTIONS, getHarnessModelCacheKey, isReadingActionSupported, isReadingService, normalizeHarnessPreferences, type HarnessActionId} from '@/src/core/config/harness';
import {services} from '@/src/core/config/catalog';
import {useUiI18n} from '@/src/ui/i18n';

const props = defineProps<{
  onSelectionRangeChange?: (range: Range | null) => void;
  onFocusedCardDismiss?: () => void;
  /** 扩展自有文档页可提供更严格的来源范围及纯文本上下文；普通网页继续使用默认规则。 */
  selectionAdapter?: {
    acceptsRange: (range: Range) => boolean;
    extractText?: (range: Range, nativeText: string) => string;
    normalizeText?: (text: string) => string;
    context?: (range: Range, text: string, limit: number) => {text: string; title: string; sourceUrl: string};
    captureReading?: (range: Range, text: string, limit: number) => ReadingSelection;
    captureMaterial?: (range: Range, quote: string) => ReturnType<typeof captureMaterialSelection>;
    subscribeInvalidation?: (listener: () => void) => () => void;
  };
}>();
const {t, translateLegacy} = useUiI18n();
const shareCardAvailable = isShareCardMounted();

type SelectionTrigger = 'direct' | 'icon' | 'dot' | 'shortcut' | 'contextMenu';
type AudioKind = 'source' | 'translation' | 'word';
type CopyKind = 'source' | 'translation';
interface SelectionSnapshot { text: string; nativeText: string; rangeText: string; parts: SelectionTextPart[]; range: Range; anchor: SelectionRect; isForward: boolean; }
interface ContextMenuSelection { snapshot: SelectionSnapshot; rangeText: string; }
interface SelectionAuthenticationError { request: SelectionContentRequest; requestId: number; service?: string; }

const tooltipRef = useTemplateRef<HTMLElement>('tooltip-ref');
const readingPanelRef = useTemplateRef<InstanceType<typeof ReadingPanel>>('reading-panel-ref');
const readingToolsTarget = useTemplateRef<HTMLElement>('reading-tools-target');
const selectionTranslatorIconUrl = browser.runtime.getURL('/icon/128.png');
const selectedText = ref('');
const manuallyRequestedSelection = ref(false);
const activeContentRequest = ref<SelectionContentRequest | null>(null);
const translationAnswer = ref<SelectionAnswerCandidate | null>(null);
const dictionaryAnswer = ref<SelectionAnswerCandidate | null>(null);
const translationResult = ref('');
const translationParts = ref<SelectionTextPart[]>([]);
const isLoading = ref(false);
const error = ref('');
const authenticationError = shallowRef<SelectionAuthenticationError | null>(null);
const openingAuthenticationSettings = shallowRef<{authentication: SelectionAuthenticationError} | null>(null);
const showIndicator = ref(false);
const showTooltip = ref(false);
const readingMode = ref(false);
const readingInitialAction = ref<HarnessActionId>();
const readingHistoryOnly = ref(false);
const readingSelection = ref<ReadingSelection | null>(null);
const freeReadingPending = ref(false);
let componentDisposed = false;
let freeReadingEnable: {selection: SelectionSnapshot; text: string; previousPreferences: string; nextPreferences: string; cancelled: boolean} | undefined;
function cancelFreeReadingEnable(): void { freeReadingEnable = undefined; freeReadingPending.value = false; }
function invalidateFreeReadingEnable(): void {
  // 保存不能取消，但失去选区所有权立即阻止迟到打开；确认前仍锁住乐观启用的讲解入口。
  if (freeReadingEnable) freeReadingEnable.cancelled = true;
}
let readingEvidenceAnchor: ReadingEvidenceAnchor | undefined;
const readingSourceRevision = ref(0);
let readingEvidenceScrollFrame: number | undefined;
function clearReadingEvidenceScroll(): void {
  if (readingEvidenceScrollFrame !== undefined) window.cancelAnimationFrame(readingEvidenceScrollFrame);
  readingEvidenceScrollFrame = undefined;
}
const locateReadingEvidence: ReadingEvidenceAnchor['locate'] = citation => {
  clearReadingEvidenceScroll();
  // instant scrollIntoView 的 scroll 事件在下一次绘制前派发；仅保留本次定位的两帧。
  readingEvidenceScrollFrame = window.requestAnimationFrame(() => {
    readingEvidenceScrollFrame = window.requestAnimationFrame(() => { readingEvidenceScrollFrame = undefined; });
  });
  const result = readingEvidenceAnchor?.locate(citation) ?? 'unavailable';
  if (result !== 'located') clearReadingEvidenceScroll();
  return result;
};
const clearReadingEvidence = () => { clearReadingEvidenceScroll(); readingEvidenceAnchor?.suspend(); };
const checkReadingEvidence = () => readingEvidenceAnchor?.check() ?? 'unavailable';
function disposeReadingEvidence(): void { clearReadingEvidenceScroll(); readingEvidenceAnchor?.dispose(); readingEvidenceAnchor = undefined; }
watch(readingSelection, selection => { if (!selection) disposeReadingEvidence(); }, {flush: 'sync'});
const copySuccess = ref(false);
const copiedTextKind = ref<CopyKind | null>(null);
const isDarkTheme = ref(false);
const indicatorStyle = ref<Record<string, string>>({});
const tooltipStyle = ref<Record<string, string>>({});
const popupPlacement = ref<'top' | 'bottom'>('top');
const pageZoom = ref(1);
const viewportSize = ref(getSafeVisualViewportRect());
const touchInteraction = ref(false);
const px = (value: number) => value + 'px';
const noticeViewportStyle = computed(() => {
  const viewport = viewportSize.value, gap = touchInteraction.value ? 12 : 18;
  // 44px 动作加两侧9px内边距；先收外边距，极矮时再收内边距，不压小动作。
  const gapY = Math.min(gap, Math.max(0, (viewport.height - 62) / 2));
  const height = Math.max(1, viewport.height - gapY * 2), padding = Math.min(9, Math.max(0, (height - 44) / 2));
  // 与主卡使用相同的布局坐标；不假设键盘出现后的 innerHeight 仍是布局视口高度。
  return {
    left: px(viewport.right - gap), top: px(viewport.bottom - gapY),
    right: 'auto', bottom: 'auto', transform: 'translate(-100%, -100%)',
    maxWidth: px(Math.max(1, viewport.width - gap * 2)),
    maxHeight: px(height), paddingBlock: px(padding),
    '--fr-notice-content-height': px(Math.max(1, height - padding * 2)),
    alignItems: height < 44 ? 'flex-start' : 'center',
  };
});
const popupScale = computed(() => 1 / pageZoom.value);
// 正常卡至少保留140px内容外框和上下12px间距；不足时让整卡成为滚动所有者。
const isShortViewport = () => viewportSize.value.height < 140 * popupScale.value + 24;
const tooltipScaleStyle = computed(() => {
  const {width, height} = viewportSize.value, scale = popupScale.value, compact = isShortViewport();
  return {
    transform: `scale(${scale})`, transformOrigin: 'top left',
    maxWidth: px(Math.max(1, width - 24) / scale),
    maxHeight: px(Math.min(520, Math.max(1, height - (compact ? 0 : 20)) / scale)),
    ...(compact ? {'--fr-pad': px(Math.min(4, Math.max(0, (height / scale - 44) / 2)))} : {}),
  };
});
const snapshot = ref<SelectionSnapshot | null>(null);
watch(snapshot, current => {
  if (readingKeyboardFocus && current !== readingKeyboardFocus.selection) clearReadingKeyboardFocus();
  if (import.meta.env.BROWSER === 'safari' && readingCardPan && current !== readingCardPan.focus.selection) clearReadingKeyboardFocus();
  if (freeReadingEnable && current !== freeReadingEnable.selection) invalidateFreeReadingEnable();
}, {flush: 'sync'});
const isPlaying = ref(false);
const isPreparingAudio = ref(false);
const audioProgress = ref<SpeechProgress | null>(null);
const audioPosition = ref<SpeechPlaybackPosition | null>(null);
const seekControls = [{offset:-5, label:'后退 5 秒'}, {offset:5, label:'前进 5 秒'}] as const;
const audioTextOffset = ref(0);
// 一次遍历计算 UTF-16 偏移；音频每帧更新只复用这些片段，不重新切片累计。
function textPartsWithOffsets(parts: readonly SelectionTextPart[] | undefined) {
  let offset = 0;
  return (parts ?? []).map(part => {
    const positioned = {...part, offset};
    offset += part.text.length;
    return positioned;
  });
}
const sourceTextParts = computed(() => textPartsWithOffsets(snapshot.value?.parts));
const translatedTextParts = computed(() => textPartsWithOffsets(translationParts.value));
function audioProgressFor(kind: AudioKind) {
  const progress = isPlaying.value && currentAudioKind.value === kind ? audioProgress.value : null;
  return progress ? {...progress,start:progress.start+audioTextOffset.value,end:progress.end+audioTextOffset.value} : null;
}
const sourceAudioProgress = computed(() => audioProgressFor('source'));
const translationAudioProgress = computed(() => audioProgressFor('translation'));
const currentAudioKind = ref<AudioKind | null>(null);
const currentAudioText = ref('');
const currentAudioKey = ref('');
const wordCard = ref<WordCardData | null>(null);
const isWordCardLoading = ref(false);
const isWordCardSupportLoading = ref(false);
const wordCardError = ref('');
const showChineseSupport = ref(true);
const noticeMessage = ref('');
const noticeAction = ref<'open-vocabulary' | 'open-local-tts' | null>(null);
const isVocabularySaved = ref(false);
const vocabularyBusy = ref(false);

let readingHoverTimer: number | null = null;
let entryDismissTimer: number | null = null;
let selectionFrame: number | null = null;
let clickSelectionFirstReadPending = false;
let positionFrame: number | null = null;
let positionRevision = 0;
let zoomRequestGeneration = 0;
let selectionLossTimer: number | null = null;
let selectionPresentationTimer: number | null = null;
let selectionPresentationVersion = 0;
let selectionSettledAt = 0;
let pendingSelectionPresentation: 'indicator' | 'tooltip' | null = null;
let translationAbortController: AbortController | null = null;
let translationRequestId = 0;
let wordLookupRequestId = 0;
let wordLookupAbortController: AbortController | null = null;
let copyTimer: number | null = null;
const vocabularyLookupGate = new SelectionRequestTokenGate();
const vocabularySaveGate = new SelectionRequestTokenGate();
let contentRequestGeneration = 0;
let noticeTimer: number | null = null;
let lastTrustedSelectionInteractionAt = 0;
const TRUSTED_SELECTION_INTERACTION_GRACE_MS = 1_500;
// 原生选区句柄可能由系统处理而不向网页继续派发 pointer 事件；只给明确的触摸会话有限宽限。
const TOUCH_SELECTION_GRACE_MS = 30_000;
const TOUCH_SELECTION_SETTLE_MS = 250;
let touchSelectionActiveUntil = 0;
let touchSelectionTimer: number | null = null;
let unsubscribeVisualViewport: (() => void) | null = null;
let readingFocusGestureAt: number | undefined;
let readingKeyboardTimer: number | undefined;
let readingKeyboardFocus: {input: HTMLElement; card: HTMLElement; selection: SelectionSnapshot;
  expiresAt: number; width: number; height: number; scale: number; landscape: boolean; rotating: boolean;
  revealViewport: typeof viewportSize.value; reveal?: boolean} | undefined;
let readingCardPan: {focus: NonNullable<typeof readingKeyboardFocus>; pointerId: number | undefined;
  x: number; y: number; local: boolean; expiresAt: number; width: number; scale: number; scrollY: number; travel: number} | undefined;

let audio: HTMLAudioElement | null = null;
let audioUrl = '';
let pageAudioProgressTimer: ReturnType<typeof setInterval> | undefined;
let utterance: SpeechSynthesisUtterance | null = null;
const ttsContentController = createSelectionTtsContentController({
  createClientRequestId: createSelectionTtsClientRequestId,
  stopRemote: (clientRequestId) => browser.runtime.sendMessage({
    type: 'selectionTtsStop',
    clientRequestId,
  }),
});
let isSelecting = false;
let dismissedSelection: SelectionSnapshot | null = null;
// Safari/Firefox 触摸入口明确消费的快照拥有卡片；不复用会影响反向目标语言的手动翻译标志。
let touchOpenedSelection: SelectionSnapshot | null = null;
// Firefox 原生菜单可能只交付 pointerdown/up 而不合成 click；只记录入口本身的触摸手势。
let indicatorTouchGesture: {pointerId: number; x: number; y: number; selection: SelectionSnapshot; element: EventTarget | null} | null = null;
let ignoreIndicatorTouchClick = false;
let pendingSelectionShortcutUntil = 0;
let selectionShortcutHeld = false;
let uiPointerInteraction = false;
let suppressSelectionUntil = 0;
let systemThemeMedia: MediaQueryList | null = null;
let unsubscribeConfig: (() => void) | null = null;
let unsubscribeSelectionSource: (() => void) | null = null;
const runtimeMessageUnsubscribers: Array<() => void> = [];
let releaseContextMenuHandler: (() => void) | null = null;
// 原生菜单可能让 Selection 暂时折叠；只保存 trusted contextmenu 已审核的 Range，不从浏览器文本猜测 DOM 位置。
let contextMenuSelection: ContextMenuSelection | null = null;
let contextMenuSourceRejected = false;
let tooltipResizeObserver: ResizeObserver | null = null;
const selectionConfigVersion = ref(0);
const clickSelectionState = ref<'idle' | 'start' | 'end'>('idle');
const clickSelectionNotice = ref('');
const clickSelection = createClickSelectionController({
  onStateChange: state => { clickSelectionState.value = state; clickSelectionNotice.value = ''; },
  onReject: reason => {
    clickSelectionNotice.value = {
      'range-too-large': '选区过长，请点击较近的终点',
      'protected-content': '此范围不支持，请换一个终点',
      'text-miss': clickSelectionState.value === 'start' ? '未点中文字，请点击起点' : '未点中文字，请点击终点',
      'same-point': '起点与终点相同，请换一个位置',
    }[reason];
  },
  onComplete: () => {
    isSelecting = false;
    uiPointerInteraction = false;
    suppressSelectionUntil = 0;
    dismissedSelection = null;
    lastTrustedSelectionInteractionAt = Date.now();
    scheduleSelectionRead();
    clickSelectionFirstReadPending = selectionFrame !== null;
  },
});
// 文档阅读器有自己的选区模型；此处只在普通网页启用两点选取。
watch(() => {
  selectionConfigVersion.value;
  if (props.selectionAdapter || !isClickSelectionAvailable(config)) return '';
  return `${config.selectionClickSelectHotkey}:${findClickSelectionHotkeyConflict(config, config.selectionClickSelectHotkey)}`;
}, () => clickSelection.cancel());
const readingPreferences = computed(() => {
  selectionConfigVersion.value;
  return normalizeHarnessPreferences(config.harness, config.customOpenAIProviders);
});
// 配置通知也包含外观等无关变更，只有模型输入变化才使阅读结果失效。
const readingModelRevision = ref(0);
watch(() => {
  selectionConfigVersion.value;
  return getHarnessModelCacheKey(config);
}, () => { readingModelRevision.value += 1; });
const readingEnabled = computed(() => selectionSettings.value.mode !== 'disabled' && readingPreferences.value.enabled && !freeReadingPending.value);
const canEnableFreeReading = computed(() => {
  selectionConfigVersion.value;
  // 新免费入口依赖扩展流式端口；不改 userscript 已有阅读配置。显式 AI 偏好不能被替换，默认B站可启用同一服务。
  return import.meta.env.BROWSER !== 'userscript' && selectionSettings.value.mode !== 'disabled' && !readingPreferences.value.enabled
    && !config.harness.service.trim() && !config.harness.model.trim()
    && (config.service === services.bilibili || !isReadingService(config.service, config.customOpenAIProviders));
});
const readingService = computed(() => {
  selectionConfigVersion.value;
  return readingPreferences.value.service || config.service;
});
const readingActions = computed(() => HARNESS_ACTIONS.filter(action => readingPreferences.value.actions.includes(action.id) && isReadingActionSupported(readingService.value, action.id)));
// 仅临时选择当前服务可用的动作；切换服务不会改写用户保存的动作和默认值。
const readingDefaultAction = computed(() => readingActions.value.find(action => action.id === readingPreferences.value.defaultAction)?.id
  || readingActions.value.find(action => action.id === 'meaning')?.id || readingActions.value[0]?.id || 'meaning');

watch(() => snapshot.value?.range ?? null, (range) => {
  props.onSelectionRangeChange?.(range);
}, { flush: 'post' });

const selectionShortcutTriggers = new Set(['Control', 'Alt', 'Shift', 'custom']);
const selectionSettings = computed(() => {
  // `config` 与内容脚本运行时共享，且会在 Vue 外部变更；用本地响应式版本让 Popup/Options
  // 的配置变化立即刷新当前选词界面，无需重新加载页面。
  selectionConfigVersion.value;
  return {
    trigger: config.selectionTranslatorTrigger,
    customHotkey: config.customSelectionTranslatorHotkey,
    delay: config.selectionTranslatorDelay,
    autoDismiss: config.selectionTranslatorAutoDismiss,
    mode: config.selectionTranslatorMode,
    theme: config.theme,
    from: config.from,
    to: config.to,
    bidirectional: config.selectionTranslatorBidirectional,
    service: config.selectionTranslationService || config.service,
    model: `${config.model?.[config.selectionTranslationService || config.service] || ''}:${config.customModel?.[config.selectionTranslationService || config.service] || ''}`,
  };
});
const selectionShortcutConfig = computed(() => selectionShortcutTriggers.has(selectionSettings.value.trigger)
  && selectionSettings.value.mode !== 'disabled'
  ? selectionSettings.value.trigger
  : 'none');
const selectionShortcut = computed(() => {
  const resolved = resolveConfiguredHotkey(selectionShortcutConfig.value, selectionSettings.value.customHotkey);
  return resolved === 'none' ? '' : resolved;
});
const triggerMode = computed<SelectionTrigger>(() => {
  if (selectionSettings.value.trigger === 'contextMenu') return 'contextMenu';
  if (selectionShortcut.value) return 'shortcut';
  if (selectionSettings.value.trigger === 'direct' || selectionSettings.value.trigger === 'dot') return selectionSettings.value.trigger;
  return 'icon';
});
const UI_SELECTION_SUPPRESSION_MS = 350;
const SELECTION_LOSS_GRACE_MS = 160;
const PENDING_SELECTION_SHORTCUT_MS = 250;

const selectedWord = computed(() => normalizeEnglishWord(selectedText.value));
const hasDistinctTranslationResult = computed(() => hasDistinctTranslation(selectedText.value, translationResult.value));
const reverseTargetLanguage = computed(() => selectionReverseTarget(selectedText.value, selectionSettings.value.to, selectionSettings.value.from));
const effectiveTargetLanguage = computed(() => (selectionSettings.value.bidirectional || manuallyRequestedSelection.value) && reverseTargetLanguage.value
  ? reverseTargetLanguage.value : selectionSettings.value.to);
const effectiveSourceLanguage = computed(() => {
  return reverseTargetLanguage.value && effectiveTargetLanguage.value === reverseTargetLanguage.value
    ? selectionSettings.value.to : selectionSettings.value.from;
});
const isWordSelection = computed(() => Boolean(selectedWord.value) && effectiveTargetLanguage.value !== 'en'
  && (effectiveSourceLanguage.value === 'auto' || /^en(?:-|$)/i.test(effectiveSourceLanguage.value)));
const isWordCardVisible = computed(() => isWordSelection.value && wordCard.value !== null);
const isPrivateContext = browser.extension.inIncognitoContext === true;
const currentContentRequest = computed<SelectionContentRequest | null>(() => {
  const request = activeContentRequest.value;
  if (!request || snapshot.value?.text !== request.text || selectedText.value !== request.text
    || effectiveTargetLanguage.value !== request.targetLanguage) return null;
  return request;
});
const vocabularyAnswer = computed(() => resolveSelectionVocabularyAnswer(currentContentRequest.value, translationAnswer.value, dictionaryAnswer.value));
const vocabularyButtonTitle = computed(() => {
  if (vocabularyBusy.value) return t('reading.savingSource');
  if (!vocabularyAnswer.value) return '译文准备完成后可收藏';
  if (isVocabularySaved.value) return '已收藏；再次点击更新当前阅读上下文';
  return t('reading.saveSourceTitle');
});
const copySuccessMessage = computed(() => copiedTextKind.value === 'source' ? '已复制原文' : '已复制译文');

function updateTheme(): void {
  isDarkTheme.value = config.theme === 'dark' || (config.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function toSelectionRect(rect: DOMRect | DOMRectReadOnly): SelectionRect {
  return { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
}

function isExtensionSelection(selection: Selection): boolean {
  const host = document.getElementById('fluent-read-selection-translator-container');
  return Boolean(host && selection.containsNode(host, true));
}

function readSelectionSnapshot(): SelectionSnapshot | null {
  try {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed || isExtensionSelection(selection)) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (!isSelectionRangeConnected(range)
      || (props.selectionAdapter ? !props.selectionAdapter.acceptsRange(range) : shouldIgnoreSelection(range))) return null;
    const nativeText = selection.toString();
    const sourceText = props.selectionAdapter?.extractText?.(range, nativeText) ?? nativeText;
    const parts = props.selectionAdapter?.normalizeText
      ? [{kind: 'text' as const, text: props.selectionAdapter.normalizeText(sourceText)}]
      : readSelectionParts(range, sourceText);
    const text = parts.map(part => part.text).join('');
    if (!text || text.length > 4096) return null;

    const rects = Array.from(range.getClientRects()).map(toSelectionRect).filter(rect => rect.width > 0 || rect.height > 0);
    const visualRects = rects.length > 0 ? rects : [toSelectionRect(range.getBoundingClientRect())];
    const isForward = selection.anchorNode === range.startContainer && selection.anchorOffset === range.startOffset;
    const anchor = chooseSelectionRect(visualRects, isForward);
    if (!anchor || (anchor.width === 0 && anchor.height === 0)) return null;
    // 跨段时 Selection 会插入段落换行，Range 的序列化则可能直接拼接文本；各自只与同一种序列化核对。
    return { text, nativeText, rangeText: range.toString(), parts, range, anchor, isForward };
  } catch {
    // 文档/Range 在导航或宿主重绘期间失效时，据实返回缺选区，不让页面事件或菜单消息抛错。
    return null;
  }
}

function isSelectionRangeConnected(range: Range): boolean {
  return Boolean(range.startContainer.isConnected && range.endContainer.isConnected
    && range.startContainer.ownerDocument === document && range.endContainer.ownerDocument === document
    && !range.collapsed);
}

function scheduleSelectionRead(shortcutTriggered = false): void {
  if (clickSelection.active) return;
  if (shortcutTriggered) pendingSelectionShortcutUntil = performance.now() + PENDING_SELECTION_SHORTCUT_MS;
  if (isSelecting || isSelectionReadSuppressed()) return;
  if (selectionFrame !== null) return;
  selectionFrame = window.requestAnimationFrame(() => {
    selectionFrame = null;
    clickSelectionFirstReadPending = false;
    const shouldTriggerShortcut = pendingSelectionShortcutUntil >= performance.now();
    pendingSelectionShortcutUntil = 0;
    if (!isSelecting && !isSelectionReadSuppressed()) applySelection(readSelectionSnapshot(), shouldTriggerShortcut);
  });
}

function cancelTouchSelectionRead(): void {
  if (touchSelectionTimer !== null) window.clearTimeout(touchSelectionTimer);
  touchSelectionTimer = null;
}

function isTouchSelectionActive(): boolean {
  return touchInteraction.value && Date.now() < touchSelectionActiveUntil;
}

function scheduleTouchSelectionRead(): void {
  cancelTouchSelectionRead();
  if (!isTouchSelectionActive() || isSelecting || isSelectionReadSuppressed() || contextMenuSourceRejected) return;
  touchSelectionTimer = window.setTimeout(() => {
    touchSelectionTimer = null;
    if (!componentDisposed && isTouchSelectionActive() && document.visibilityState !== 'hidden') scheduleSelectionRead();
  }, TOUCH_SELECTION_SETTLE_MS);
}

function suppressSelectionRead(duration = UI_SELECTION_SUPPRESSION_MS): void {
  clickSelectionFirstReadPending = false;
  suppressSelectionUntil = Math.max(suppressSelectionUntil, performance.now() + duration);
  if (selectionFrame !== null) {
    window.cancelAnimationFrame(selectionFrame);
    selectionFrame = null;
  }
}

function isSelectionReadSuppressed(): boolean {
  return uiPointerInteraction || performance.now() < suppressSelectionUntil;
}

function isSelectionInTargetLanguage(text: string): boolean {
  if (selectionSettings.value.bidirectional && selectionReverseTarget(text, config.to, config.from)) return false;
  return shouldSkipChineseSelection(text, config.to) || shouldSkipTranslationForTarget(text, config.to);
}

function isSameSelection(left: SelectionSnapshot | null, right: SelectionSnapshot): boolean {
  if (!left || left.text !== right.text || left.parts?.length !== right.parts?.length
    || left.parts?.some((part, index) => part.kind !== right.parts[index].kind || part.text !== right.parts[index].text)) return false;
  return left.range.startContainer === right.range.startContainer
    && left.range.startOffset === right.range.startOffset
    && left.range.endContainer === right.range.endContainer
    && left.range.endOffset === right.range.endOffset;
}

function cancelSelectionLoss(): void {
  if (selectionLossTimer === null) return;
  window.clearTimeout(selectionLossTimer);
  selectionLossTimer = null;
}

function cancelSelectionPresentation(): void {
  cancelReadingHover();
  cancelEntryDismiss();
  if (selectionPresentationTimer !== null) {
    window.clearTimeout(selectionPresentationTimer);
    selectionPresentationTimer = null;
  }
  pendingSelectionPresentation = null;
  selectionPresentationVersion += 1;
}

function clearCopyFeedback(): void {
  if (copyTimer !== null) window.clearTimeout(copyTimer);
  copyTimer = null;
  copySuccess.value = false;
  copiedTextKind.value = null;
}

function resetSelectionContentState(clearSelectionText = false): void {
  clearReadingKeyboardFocus();
  translationRequestId += 1;
  translationAbortController?.abort();
  translationAbortController = null;
  wordLookupRequestId += 1;
  wordLookupAbortController?.abort();
  wordLookupAbortController = null;
  isLoading.value = false;
  activeContentRequest.value = null;
  translationAnswer.value = null;
  dictionaryAnswer.value = null;
  translationResult.value = '';
  translationParts.value = [];
  error.value = '';
  authenticationError.value = null;
  openingAuthenticationSettings.value = null;
  wordCard.value = null;
  isWordCardLoading.value = false;
  isWordCardSupportLoading.value = false;
  wordCardError.value = '';
  showChineseSupport.value = true;
  clearCopyFeedback();
  vocabularyLookupGate.invalidate();
  vocabularySaveGate.invalidate();
  isVocabularySaved.value = false;
  vocabularyBusy.value = false;
  if (clearSelectionText) selectedText.value = '';
  stopAudio();
}

function revealSelectionPresentation(
  presentation: 'indicator' | 'tooltip',
  expectedVersion: number,
): void {
  if (expectedVersion !== selectionPresentationVersion
    || pendingSelectionPresentation !== presentation
    || !snapshot.value) return;

  const expectedSelection = snapshot.value;
  const currentSelection = readSelectionSnapshot();
  if (!currentSelection) { hideAll(); return; }
  if (!isSameSelection(expectedSelection, currentSelection)) {
    applySelection(currentSelection);
    return;
  }

  snapshot.value = currentSelection;
  pendingSelectionPresentation = null;
  if (presentation === 'tooltip') {
    openTooltip();
    return;
  }
  showIndicator.value = true;
  showTooltip.value = false;
  updatePosition(false);
}

function scheduleSelectionPresentation(presentation: 'indicator' | 'tooltip'): void {
  if (!snapshot.value) return;
  if (selectionPresentationTimer !== null) {
    window.clearTimeout(selectionPresentationTimer);
    selectionPresentationTimer = null;
  }
  pendingSelectionPresentation = presentation;
  const expectedVersion = ++selectionPresentationVersion;
  const remaining = getSelectionPresentationDelayRemaining(
    selectionSettings.value.delay,
    selectionSettledAt,
    performance.now(),
  );
  if (remaining === 0) {
    revealSelectionPresentation(presentation, expectedVersion);
    return;
  }
  selectionPresentationTimer = window.setTimeout(() => {
    selectionPresentationTimer = null;
    revealSelectionPresentation(presentation, expectedVersion);
  }, remaining);
}

function scheduleSelectionLoss(): void {
  if (touchOpenedSelection && touchOpenedSelection === snapshot.value && showTooltip.value) {
    restoreSelectionSource();
    return;
  }
  // 明确打开的卡片拥有自己的选区快照，不因原生菜单收起或网页清除高亮取消请求。
  if (!snapshot.value || import.meta.env.BROWSER !== 'userscript'
    && (contextMenuSelection || manuallyRequestedSelection.value && showTooltip.value)) return;
  if (selectionLossTimer !== null) return;
  selectionLossTimer = window.setTimeout(() => {
    selectionLossTimer = null;
    if (isSelecting || isSelectionReadSuppressed()) return;
    const recoveredSelection = readSelectionSnapshot();
    if (recoveredSelection) {
      applySelection(recoveredSelection);
      return;
    }
    hideAll();
  }, SELECTION_LOSS_GRACE_MS);
}

function applySelection(next: SelectionSnapshot | null, shortcutTriggered = false, readingTriggered = false, forced = false): void {
  if (!next) {
    if (!isSelecting) scheduleSelectionLoss();
    return;
  }
  if (!shortcutTriggered && isSameSelection(dismissedSelection, next)) return;
  dismissedSelection = null;
  cancelSelectionLoss();
  // 右键菜单是用户明确下达的指令：即使选区已是目标语言也照常出卡片，不静默丢弃。
  if (!forced && shouldSkipChineseSelection(next.text, config.to)
    && !(selectionSettings.value.bidirectional && selectionReverseTarget(next.text, config.to, config.from))) { hideAll(); return; }
  if (isSameSelection(snapshot.value, next)) {
    if (forced) manuallyRequestedSelection.value = true;
    if (readingTriggered) openReading();
    else if (forced) openTooltip(true);
    else if (shortcutTriggered) scheduleSelectionPresentation('tooltip');
    return;
  }
  if (!forced && isSelectionInTargetLanguage(next.text)) { hideAll(); return; }
  cancelSelectionPresentation();
  selectionSettledAt = performance.now();
  touchOpenedSelection = null;
  resetSelectionContentState();
  manuallyRequestedSelection.value = forced;
  readingMode.value = false;
  readingSelection.value = null;
  resetPopupGeometry();
  snapshot.value = next;
  selectedText.value = next.text;
  const waitingForManualTrigger = !shortcutTriggered && (triggerMode.value === 'shortcut' || triggerMode.value === 'contextMenu' || selectionSettings.value.mode === 'disabled');
  showIndicator.value = false;
  showTooltip.value = false;
  updatePosition(false);
  if (readingTriggered) { openReading(); return; }
  if (forced) { openTooltip(true); return; }
  if (waitingForManualTrigger) return;
  scheduleSelectionPresentation(shortcutTriggered || triggerMode.value === 'direct' ? 'tooltip' : 'indicator');
}

// 指针只在本卡片内捕获；页面原有文本、按钮和滚动条不参与拖动。
const popupResizeEdges = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;
const popupManipulating = ref(false);
let manualPopupPosition: {left: number; top: number} | null = null;
let manualPopupSize: {width: number; height: number} | null = null;
let popupGesture: {pointerId: number; x: number; y: number; rect: DOMRect; edge: string; element: HTMLElement} | null = null;
let pendingPopupPoint: {x: number; y: number} | null = null;
let popupGestureFrame: number | null = null;
let popupGestureRevision = 0;

function stopPopupGesture(event?: PointerEvent): void {
  const gesture = popupGesture;
  if (event && gesture && event.pointerId !== gesture.pointerId) return;
  // 松开时提交最后一个已接受的移动；取消、失焦和卸载直接作废未绘制的旧手势。
  if (event?.type === 'pointerup' && gesture) flushPopupGesture(gesture);
  popupGestureRevision += 1;
  if (popupGestureFrame !== null) window.cancelAnimationFrame(popupGestureFrame);
  popupGestureFrame = null;
  pendingPopupPoint = null;
  popupGesture = null;
  popupManipulating.value = false;
  if (gesture?.element.hasPointerCapture(gesture.pointerId)) gesture.element.releasePointerCapture(gesture.pointerId);
}

function resetPopupGeometry(): void {
  stopPopupGesture();
  cancelPositionUpdate();
  manualPopupPosition = null;
  manualPopupSize = null;
}

function applyManualPopupGeometry(measured?: Pick<DOMRect, 'width'>): void {
  const element = tooltipRef.value;
  if (!element || !manualPopupPosition) return;
  const scale = popupScale.value;
  const viewport = viewportSize.value;
  const width = Math.min(manualPopupSize?.width ?? measured?.width ?? element.getBoundingClientRect().width, Math.max(1, viewport.width - 24));
  const left = Math.max(viewport.left + 12, Math.min(manualPopupPosition.left, viewport.right - width - 12));
  const compact = isShortViewport();
  // 临时退化只改变呈现，不写回用户几何；常规卡仍保留左上角和原高度限制。
  const top = compact ? viewport.top : Math.max(viewport.top + 12, Math.min(manualPopupPosition.top, viewport.bottom - Math.min(140 * scale, Math.max(1, viewport.height - 24)) - 12));
  const availableHeight = compact ? viewport.height : Math.max(1, viewport.bottom - top - 12);
  const height = manualPopupSize ? Math.min(manualPopupSize.height, availableHeight) : undefined;
  if (!compact) {
    manualPopupPosition = {left, top};
    if (manualPopupSize) manualPopupSize = {width, height: height!};
  }
  tooltipStyle.value = {
    left: px(left), top: px(top),
    maxHeight: px((compact || manualPopupSize ? availableHeight : Math.min(520 * scale, availableHeight)) / scale),
    ...(manualPopupSize ? {width: px(width / scale)} : {}),
    ...(height !== undefined ? {height: px(height / scale)} : {}),
  };
}

// 自动卡保留自然高度，为生成/播放底栏留出真实空间；手动尺寸仍由用户控制。
watch([readingMode, showTooltip], () => {
  if (readingMode.value || !showTooltip.value) openingAuthenticationSettings.value = null;
}, {flush: 'sync'});

function beginPopupGesture(event: PointerEvent): void {
  const element = tooltipRef.value;
  const target = event.target;
  // document capture 先保存原焦点身份；只有实际卡片本地收到同一次按下才确认，不凭 Shadow host 猜目标。
  if (import.meta.env.BROWSER === 'safari' && readingCardPan) {
    if (event.isTrusted && event.pointerId === readingCardPan.pointerId && event.currentTarget === readingCardPan.focus.card
      && target instanceof Node && readingCardPan.focus.card.contains(target)) readingCardPan.local = true;
    else clearReadingKeyboardFocus();
  }
  if (isShortViewport() || !event.isTrusted || !event.isPrimary || event.button !== 0 || !element || !(target instanceof HTMLElement)) return;
  if (target.closest('button, summary, a, input, textarea, select, [contenteditable]')) return;
  const edge = target.dataset.resizeEdge ?? '';
  const blank = target.matches('.fr-translation-tooltip, .fr-tooltip-content, .fr-translation-container, .fr-text-block');
  // 触摸正文应滚动或选词，不让空白拖动吞掉原生平移；触摸仅从明确的标题栏移动卡片。
  if (event.pointerType === 'touch' && (edge || blank)) return;
  if (!edge && !target.matches('.fr-study-navigation') && !blank) return;
  // 不截获内容滚动条上的按下。
  if (!edge && blank && event.clientX >= target.getBoundingClientRect().left + target.clientLeft + target.clientWidth) return;
  event.preventDefault();
  stopPopupGesture();
  const rect = element.getBoundingClientRect();
  popupGesture = {pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, edge, element};
  element.setPointerCapture(event.pointerId);
  popupManipulating.value = true;
}

function movePopupGesture(event: PointerEvent): void {
  const gesture = popupGesture;
  if (!event.isTrusted || !gesture || event.pointerId !== gesture.pointerId) return;
  event.preventDefault();
  event.stopPropagation();
  pendingPopupPoint = {x: event.clientX, y: event.clientY};
  if (popupGestureFrame !== null) return;
  const revision = ++popupGestureRevision;
  popupGestureFrame = window.requestAnimationFrame(() => {
    if (revision !== popupGestureRevision) return;
    popupGestureFrame = null;
    flushPopupGesture(gesture);
  });
}

function flushPopupGesture(gesture: NonNullable<typeof popupGesture>): void {
  const point = pendingPopupPoint;
  if (popupGesture !== gesture || !point) return;
  pendingPopupPoint = null;
  const dx = point.x - gesture.x;
  const dy = point.y - gesture.y;
  const {rect, edge} = gesture;
  if (!edge) {
    manualPopupPosition = {left: rect.left + dx, top: rect.top + dy};
  } else {
    const viewport = viewportSize.value;
    const minWidth = Math.min(280 * popupScale.value, viewport.width - 24);
    const minHeight = Math.min(140 * popupScale.value, viewport.height - 24);
    let {left, top, right, bottom} = rect;
    if (edge.includes('w')) left = Math.max(viewport.left + 12, Math.min(rect.left + dx, right - minWidth));
    if (edge.includes('e')) right = Math.min(viewport.right - 12, Math.max(rect.right + dx, left + minWidth));
    if (edge.includes('n')) top = Math.max(viewport.top + 12, Math.min(rect.top + dy, bottom - minHeight));
    if (edge.includes('s')) bottom = Math.min(viewport.bottom - 12, Math.max(rect.bottom + dy, top + minHeight));
    manualPopupPosition = {left, top};
    manualPopupSize = {width: right - left, height: bottom - top};
  }
  // 手势从按下时的矩形算绝对位移，移动帧不用再读取写入后的卡片布局。
  applyManualPopupGeometry(rect);
}


function updatePosition(refreshSelection = true): void {
  const current = snapshot.value;
  if (!current) return;
  const revision = positionRevision;
  // 卡片首次打开后使用自己的锚点；内容、播放或页面滚动不需反复量宿主选区。
  if (showTooltip.value && manualPopupPosition) { applyManualPopupGeometry(); return; }
  const rects = refreshSelection
    ? Array.from(current.range.getClientRects()).map(toSelectionRect).filter(rect => rect.width > 0 || rect.height > 0)
    : [];
  const anchor = refreshSelection
    ? chooseSelectionRect(rects.length > 0 ? rects : [current.anchor], current.isForward)
    : current.anchor;
  if (!anchor) return;
  current.anchor = anchor;
  const viewport = viewportSize.value;
  const firefoxTouch = import.meta.env.BROWSER === 'firefox' && touchInteraction.value;
  const viewportInset = (touchInteraction.value ? 28 : 14) * popupScale.value;
  // Gecko 的原生触摸手柄还覆盖文字端点；锚点距离独立于视口边距，不能一起放大。
  const anchorOffset = (firefoxTouch ? 72 : touchInteraction.value ? 28 : 14) * popupScale.value;
  const minEntryLeft = viewport.left + viewportInset, maxEntryLeft = viewport.right - viewportInset;
  let entryLeft = current.isForward ? anchor.right + anchorOffset : anchor.left - anchorOffset;
  if (touchInteraction.value) {
    // 原生选区菜单在文字上方或下方；触摸入口放在端点所在行的侧面，不探测或猜测系统菜单尺寸。
    // 端点靠边时优先换到该行另一侧；整行都占满时仍由可见视口保留入口的完整触摸面积。
    const oppositeLeft = current.isForward ? anchor.left - anchorOffset : anchor.right + anchorOffset;
    if (entryLeft < minEntryLeft || entryLeft > maxEntryLeft) {
      if (oppositeLeft >= minEntryLeft && oppositeLeft <= maxEntryLeft) entryLeft = oppositeLeft;
      else if (firefoxTouch) {
        // 满行时选择远离两端的行内位置；普通夹边会把较大侧距重新压回原生手柄旁。
        const safeLeft = Math.max(anchor.left + anchorOffset, minEntryLeft);
        const safeRight = Math.min(anchor.right - anchorOffset, maxEntryLeft);
        if (safeLeft <= safeRight) entryLeft = (safeLeft + safeRight) / 2;
        // 极窄视口没有安全区时保留可见性退化，不声称此时仍能保证原生手柄侧距。
      }
    }
  }
  const entryTop = touchInteraction.value ? (anchor.top + anchor.bottom) / 2 : anchor.bottom + anchorOffset;
  indicatorStyle.value = {
    left: px(Math.max(minEntryLeft, Math.min(maxEntryLeft, entryLeft))),
    top: px(Math.max(viewport.top + viewportInset, Math.min(viewport.bottom - viewportInset, entryTop))),
  };
  if (showTooltip.value) void nextTick(() => {
    const tooltip = tooltipRef.value;
    if (!tooltip || !showTooltip.value || snapshot.value !== current || revision !== positionRevision) return;
    if (manualPopupPosition) { applyManualPopupGeometry(); return; }
    const rect = tooltip.getBoundingClientRect();
    const position = calculateSelectionPopupPosition(snapshot.value.anchor, { width: rect.width, height: rect.height }, viewportSize.value);
    manualPopupPosition = {left: position.left, top: position.top};
    applyManualPopupGeometry(rect);
    popupPlacement.value = position.placement;
  });
}

function schedulePositionUpdate(): void {
  if (!showIndicator.value && !showTooltip.value) return;
  if (positionFrame !== null) return;
  const revision = ++positionRevision;
  positionFrame = window.requestAnimationFrame(() => {
    if (revision !== positionRevision) return;
    positionFrame = null;
    updatePosition();
    if (import.meta.env.BROWSER === 'safari' && readingKeyboardFocus?.reveal) {
      const focus = readingKeyboardFocus;
      void nextTick(() => revealReadingInput(focus, revision));
    }
  });
}

function cancelPositionUpdate(): void {
  positionRevision += 1;
  if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
  positionFrame = null;
}

function applyPageZoom(value: unknown): void {
  const nextZoom = normalizeSelectionPageZoom(value);
  const previousZoom = pageZoom.value;
  if (nextZoom === previousZoom) return;
  if (import.meta.env.BROWSER === 'safari' && readingKeyboardFocus) readingKeyboardFocus.reveal = false;
  stopPopupGesture();
  // 手动位置和尺寸以视口 CSS 像素保存；缩放后换算，才能保持屏幕上的实际位置和大小。
  const ratio = previousZoom / nextZoom;
  if (manualPopupPosition) manualPopupPosition = {
    left: manualPopupPosition.left * ratio,
    top: manualPopupPosition.top * ratio,
  };
  if (manualPopupSize) manualPopupSize = {
    width: manualPopupSize.width * ratio,
    height: manualPopupSize.height * ratio,
  };
  pageZoom.value = nextZoom;
  viewportSize.value = getSafeVisualViewportRect();
  schedulePositionUpdate();
}

async function requestPageZoom(): Promise<void> {
  const generation = ++zoomRequestGeneration;
  try {
    const response = await browser.runtime.sendMessage({type: SELECTION_PAGE_ZOOM_REQUEST}) as {success?: boolean; zoom?: unknown} | undefined;
    if (generation === zoomRequestGeneration && response?.success) applyPageZoom(response.zoom);
  } catch {
    // Userscript 等无 tabs.getZoom 的环境沿用页面默认尺寸。
  }
}

function handlePageZoomChanged(message: unknown): undefined {
  if (!message || typeof message !== 'object' || (message as {type?: unknown}).type !== SELECTION_PAGE_ZOOM_CHANGED) return undefined;
  zoomRequestGeneration += 1;
  applyPageZoom((message as {zoom?: unknown}).zoom);
  return undefined;
}

function handleViewportResize(): void {
  if (import.meta.env.BROWSER === 'safari') readingKeyboardViewport();
  // 父卡下一帧会夹边移动；先收起菜单，避免沿用移动前的展开方向。
  readingPanelRef.value?.closeTools();
  // 视口宽度会改变自动卡片的真实宽度，不能继续用按下时的旧矩形夹边。
  stopPopupGesture();
  viewportSize.value = getSafeVisualViewportRect();
  if (import.meta.env.BROWSER === 'safari' && readingKeyboardFocus) {
    const focus = readingKeyboardFocus, previous = focus.revealViewport;
    focus.revealViewport = viewportSize.value;
    if (isShortViewport() && Date.now() < focus.expiresAt
      && (['width', 'height', 'top', 'left'] as const).some(key => previous[key] !== viewportSize.value[key])) focus.reveal = true;
  }
  schedulePositionUpdate();
  void requestPageZoom();
}

function openTooltip(forced = false): void {
  if (selectionSettings.value.mode === 'disabled') { hideAll(); return; }
  if (!snapshot.value || (!forced && isSelectionInTargetLanguage(snapshot.value.text))) { hideAll(); return; }
  if (forced) manuallyRequestedSelection.value = true;
  cancelSelectionPresentation();
  const wasVisible = showTooltip.value;
  showIndicator.value = true;
  showTooltip.value = true;
  readingMode.value = false;
  if (!wasVisible) tooltipStyle.value = {visibility: 'hidden'};
  if (!wasVisible || error.value || !activeContentRequest.value || (!translationResult.value && !isLoading.value && !isWordCardVisible.value)) void requestSelectionContent(snapshot.value.text);
  schedulePositionUpdate();
}

function cancelIndicatorTouch(): void {
  if (import.meta.env.BROWSER !== 'firefox') return;
  indicatorTouchGesture = null;
}

function beginIndicatorTouch(event: PointerEvent): void {
  if (import.meta.env.BROWSER !== 'firefox' || !event.isTrusted) return;
  cancelIndicatorTouch();
  ignoreIndicatorTouchClick = event.pointerType === 'touch';
  if (event.pointerType !== 'touch' || !event.isPrimary || event.button !== 0 || componentDisposed
    || !showIndicator.value || showTooltip.value || !snapshot.value
    || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
  indicatorTouchGesture = {pointerId: event.pointerId, x: event.clientX, y: event.clientY,
    selection: snapshot.value, element: event.currentTarget};
}

function trackIndicatorTouch(event: PointerEvent): void {
  if (import.meta.env.BROWSER !== 'firefox') return;
  const gesture = indicatorTouchGesture;
  if (!gesture || !event.isTrusted || event.pointerType !== 'touch') return;
  if (event.pointerId !== gesture.pointerId || !event.isPrimary
    || !(Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 8 * popupScale.value)) cancelIndicatorTouch();
}

function finishIndicatorTouch(event: PointerEvent): void {
  if (import.meta.env.BROWSER !== 'firefox') return;
  const gesture = indicatorTouchGesture;
  cancelIndicatorTouch();
  if (!gesture || !event.isTrusted || !event.isPrimary || event.pointerType !== 'touch' || event.button !== 0
    || event.pointerId !== gesture.pointerId || event.currentTarget !== gesture.element
    || componentDisposed || document.visibilityState === 'hidden' || snapshot.value !== gesture.selection || !showIndicator.value || showTooltip.value
    || !(Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 8 * popupScale.value)) return;
  // 来源 DOM 可在 down/up 之间替换而没有 selectionchange；只完成当时仍有效的同一来源。
  restoreSelectionSource();
  if (snapshot.value !== gesture.selection || !showIndicator.value) return;
  try {
    const live = readSelectionSnapshot();
    if (!live || !isSameSelection(gesture.selection, live)) return;
  } catch { return; }
  event.stopPropagation();
  openTooltipFromIndicator();
}

function leaveIndicator(): void {
  cancelReadingHover();
  cancelIndicatorTouch();
}

/** 仅显式触摸入口开启成功后清空同一原生选区；是否同时收起系统菜单仍由浏览器决定。 */
function openTooltipFromIndicator(event?: MouseEvent): void {
  // pointer 路径已处理过本轮触摸（包括取消）；键盘 detail=0 和其他平台仍保留 click 入口。
  if (import.meta.env.BROWSER === 'firefox' && ignoreIndicatorTouchClick && event
    && (event.detail !== 0 || (event as PointerEvent).pointerType === 'touch')) return;
  if (showTooltip.value) return;
  const current = snapshot.value, wasVisible = showTooltip.value;
  openTooltip();
  if ((import.meta.env.BROWSER !== 'safari' && import.meta.env.BROWSER !== 'firefox') || !touchInteraction.value || componentDisposed
    || wasVisible || !showTooltip.value || !current || snapshot.value !== current) return;
  try {
    const selection = window.getSelection();
    const live = readSelectionSnapshot();
    if (!selection || !live || !isSameSelection(current, live)) return;
    touchOpenedSelection = current;
    cancelSelectionLoss();
    cancelTouchSelectionRead();
    touchSelectionActiveUntil = 0;
    suppressSelectionRead();
    // 已保存 cloneRange、文本、parts 与锚点；不重新 addRange，也不干预后续新的正文选区。
    selection.removeAllRanges();
  } catch {
    // 选区 API 异常不能撤销已经打开且具有独立来源快照的卡片。
  }
}

function cancelReadingHover(): void {
  if (readingHoverTimer !== null) window.clearTimeout(readingHoverTimer);
  readingHoverTimer = null;
}

function scheduleIndicatorHover(event: PointerEvent): void {
  cancelEntryDismiss();
  cancelReadingHover();
  if (!event.isTrusted || event.pointerType !== 'mouse' || selectionSettings.value.trigger !== 'hover' || !snapshot.value) return;
  const expected = snapshot.value;
  readingHoverTimer = window.setTimeout(() => {
    readingHoverTimer = null;
    if (showIndicator.value && !showTooltip.value && isSameSelection(snapshot.value, expected)) openTooltip();
  }, readingPreferences.value.hoverDelay);
}

async function openSelectionSettings(): Promise<void> {
  const selection = snapshot.value, requestId = translationRequestId;
  const isCurrent = () => !componentDisposed && showTooltip.value && snapshot.value === selection && translationRequestId === requestId;
  if (!isCurrent()) return;
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-selection'});
    if (response && typeof response === 'object' && 'success' in response && response.success === false && isCurrent()) showNotice('请从扩展设置进入划词翻译');
  }
  catch { if (isCurrent()) showNotice('请从扩展设置进入划词翻译'); }
}

function isAuthenticationErrorCurrent(authentication: SelectionAuthenticationError | null): boolean {
  return Boolean(authentication && authenticationError.value === authentication
    && authentication.requestId === translationRequestId && error.value && showTooltip.value && !readingMode.value
    && isContentRequestCurrent(authentication.request)
    && (authentication.service === undefined || authentication.service === (config.selectionTranslationService || config.service)));
}

async function openAuthenticationSettings(): Promise<void> {
  const authentication = authenticationError.value;
  if (!authentication || !isAuthenticationErrorCurrent(authentication) || openingAuthenticationSettings.value) return;
  const action = {authentication};
  openingAuthenticationSettings.value = action;
  const isCurrent = () => openingAuthenticationSettings.value === action && isAuthenticationErrorCurrent(authentication);
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage', section: 'settings-general'}) as {success?: unknown} | null | undefined;
    if (response?.success !== true && isCurrent()) showNotice('无法打开设置，请从扩展菜单打开设置后重试');
  } catch {
    if (isCurrent()) showNotice('无法打开设置，请从扩展菜单打开设置后重试');
  } finally {
    if (openingAuthenticationSettings.value === action) openingAuthenticationSettings.value = null;
  }
}

async function enableFreeReading(): Promise<void> {
  if (componentDisposed || freeReadingPending.value || !canEnableFreeReading.value || !snapshot.value || !showTooltip.value) return;
  const operation = {selection: snapshot.value, text: snapshot.value.text, previousPreferences: '', nextPreferences: '', cancelled: false};
  freeReadingEnable = operation;
  freeReadingPending.value = true;
  const isCurrent = () => !componentDisposed && !operation.cancelled && freeReadingEnable === operation
    && snapshot.value === operation.selection && snapshot.value.text === operation.text
    && selectedText.value === operation.text && showTooltip.value;
  try {
    // 初次水合可能带回用户已有的 AI 选择；读取完成后再确认资格，不能用默认草稿覆盖它。
    await configReady;
    if (!isCurrent() || !canEnableFreeReading.value) return;
    const preferences = normalizeHarnessPreferences({...config.harness, enabled: true, service: services.bilibili, model: ''}, config.customOpenAIProviders);
    operation.previousPreferences = JSON.stringify(readingPreferences.value);
    operation.nextPreferences = JSON.stringify(preferences);
    await requestConfigPatch({harness: preferences}, browser.runtime.sendMessage.bind(browser.runtime));
    await nextTick();
    if (!isCurrent() || JSON.stringify(readingPreferences.value) !== operation.nextPreferences) return;
    // 乐观配置期间不能触发讲解；确认成功且选区仍归本次操作所有才打开用户默认学习动作。
    cancelFreeReadingEnable();
    openReading(readingDefaultAction.value);
  } catch {
    if (isCurrent()) showNotice('启用免费 AI 讲解失败，请重试或从设置配置');
  } finally {
    if (freeReadingEnable === operation) cancelFreeReadingEnable();
  }
}

function syncReadingView(view: {action: HarnessActionId; history: boolean}): void {
  readingInitialAction.value = view.action;
  readingHistoryOnly.value = view.history;
}

function openReading(action: HarnessActionId = readingDefaultAction.value): void {
  if (!readingActions.value.some(item => item.id === action)) return;
  readingHistoryOnly.value = false;
  readingInitialAction.value = action;
  openReadingCard();
}

function openReadingHistory(): void {
  readingHistoryOnly.value = true;
  openReadingCard();
}

/** 材料定位是附加信息；宿主 DOM 或失效选区的读取失败不能中断阅读与原有收藏。 */
function captureMaterialSafely(range: Range, quote: string): ReturnType<typeof captureMaterialSelection> {
  if (isPrivateContext) return;
  try { return props.selectionAdapter ? props.selectionAdapter.captureMaterial?.(range, quote) : captureMaterialSelection(range, quote); } catch { return; }
}

function openReadingCard(): void {
  if (!snapshot.value || !readingEnabled.value) return;
  if (shouldSkipChineseSelection(snapshot.value.text, effectiveTargetLanguage.value)) { hideAll(); return; }
  cancelSelectionPresentation();
  cancelSelectionLoss();
  if (!activeContentRequest.value || error.value || (!translationResult.value && !isLoading.value)) {
    void requestTranslation(beginSelectionContentRequest(snapshot.value.text));
  }
  stopAudio();
  if (!readingSelection.value) {
    readingSelection.value = (props.selectionAdapter?.captureReading ?? captureReadingSelection)(snapshot.value.range, snapshot.value.text,
      readingPreferences.value.contextMode === 'paragraph' ? readingPreferences.value.maxContextChars : 0);
    if (!isPrivateContext) readingSelection.value.material = captureMaterialSafely(snapshot.value.range, readingSelection.value.sentence || snapshot.value.text);
    disposeReadingEvidence();
    readingEvidenceAnchor = createReadingEvidenceAnchor(snapshot.value.range, readingSelection.value, {
      onInvalidate: () => { readingSourceRevision.value += 1; clearReadingEvidence(); },
    });
  }
  const wasVisible = showTooltip.value;
  readingMode.value = true;
  showIndicator.value = true;
  showTooltip.value = true;
  if (!wasVisible) tooltipStyle.value = {visibility: 'hidden'};
  schedulePositionUpdate();
}

function shouldUseWordCard(text: string): boolean {
  return isSingleEnglishWord(text) && effectiveTargetLanguage.value !== 'en'
    && (effectiveSourceLanguage.value === 'auto' || /^en(?:-|$)/i.test(effectiveSourceLanguage.value));
}

function beginSelectionContentRequest(text: string): SelectionContentRequest {
  resetSelectionContentState();
  const request = { text, sourceLanguage: effectiveSourceLanguage.value,
    targetLanguage: effectiveTargetLanguage.value, generation: ++contentRequestGeneration };
  activeContentRequest.value = request;
  return request;
}

function isContentRequestCurrent(request: SelectionContentRequest): boolean {
  if (props.selectionAdapter && snapshot.value && !props.selectionAdapter.acceptsRange(snapshot.value.range)) return false;
  const current = currentContentRequest.value;
  return Boolean(current && current.generation === request.generation && current.text === request.text && current.targetLanguage === request.targetLanguage);
}

function isResultSourceCurrent(request: SelectionContentRequest): boolean {
  const current = currentContentRequest.value;
  if (!current || current.generation !== request.generation || current.text !== request.text || current.targetLanguage !== request.targetLanguage) return false;
  restoreSelectionSource();
  return currentContentRequest.value === current;
}

function dictionaryDefinitions(card: WordCardData, targetLanguage: string): string {
  return resolveSelectionDictionaryFallback(targetLanguage, card.meanings.flatMap(meaning => meaning.definitions).map(definition => definition.translatedDefinition));
}

function requestSelectionContent(text: string): void {
  const request = beginSelectionContentRequest(text);
  void requestTranslation(request);
  if (shouldUseWordCard(text)) {
    void requestWordCard(request);
  }
  else {
    wordLookupRequestId += 1;
    wordCard.value = null;
    isWordCardLoading.value = false;
    wordCardError.value = '';
    dictionaryAnswer.value = null;
    isVocabularySaved.value = false;
    vocabularyBusy.value = false;
  }
  void refreshVocabularySaved(request);
}

function vocabularySourceLanguage(request: SelectionContentRequest): string {
  return request.sourceLanguage && request.sourceLanguage !== 'auto' ? request.sourceLanguage : detectlang(request.text);
}

async function refreshVocabularySaved(request: SelectionContentRequest): Promise<void> {
  if (!request.text.trim() || !config.vocabularyBookEnabled || isPrivateContext) {
    vocabularyLookupGate.invalidate();
    isVocabularySaved.value = false;
    return;
  }
  const requestToken = vocabularyLookupGate.begin();
  try {
    const response = await browser.runtime.sendMessage({type: VOCABULARY_BOOK_MESSAGE, action: 'getByTerm', term: request.text, sourceLanguage: vocabularySourceLanguage(request)}) as VocabularyBookResponse<unknown | null>;
    if (!vocabularyLookupGate.isCurrent(requestToken) || !isContentRequestCurrent(request)) return;
    isVocabularySaved.value = response?.success === true && Boolean(response.data);
  } catch {
    if (vocabularyLookupGate.isCurrent(requestToken)) isVocabularySaved.value = false;
  }
}

function selectionContextText(): string {
  const range = snapshot.value?.range;
  if (!range) return '';
  if (props.selectionAdapter?.context) return props.selectionAdapter.context(range, selectedText.value, 500).text;
  const boundary = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer as Element : range.startContainer.parentElement;
  const prose = boundary?.closest('p, li, blockquote, dd, dt, figcaption, article') || boundary?.parentElement;
  const original = prose ? projectMaterialOriginalText(prose, range) : undefined;
  // 超预算或失效时只保留实际选中文字，不回退到含双语译文的 textContent。
  return summarizeSelectionContext(original?.text || selectedText.value, selectedText.value, 500, original?.selection?.start);
}

function pageSourceUrl(): string {
  if (props.selectionAdapter?.context && snapshot.value) {
    return props.selectionAdapter.context(snapshot.value.range, selectedText.value, 0).sourceUrl;
  }
  try {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch { return ''; }
}

function selectionPageTitle(): string {
  return props.selectionAdapter?.context && snapshot.value
    ? props.selectionAdapter.context(snapshot.value.range, selectedText.value, 0).title || document.title
    : document.title;
}

async function saveVocabularyEntry(event: MouseEvent): Promise<void> {
  if (!event.isTrusted) return;
  const contentRequest = currentContentRequest.value;
  const answer = vocabularyAnswer.value;
  if (!config.vocabularyBookEnabled || !contentRequest || !answer || vocabularyBusy.value || isPrivateContext) return;
  const wasSaved = isVocabularySaved.value;
  vocabularyBusy.value = true;
  const requestToken = vocabularySaveGate.begin();
  const materialSelection = snapshot.value ? captureMaterialSafely(snapshot.value.range, contentRequest.text) : undefined;
  try {
    const context = {text: selectionContextText(), sourceUrl: pageSourceUrl(), pageTitle: selectionPageTitle(), capturedAt: Date.now()};
    const materialOperation = await beginMaterialCapture(materialSelection, isPrivateContext);
    if (!vocabularySaveGate.isCurrent(requestToken) || !isContentRequestCurrent(contentRequest)) return;
    const response = await browser.runtime.sendMessage({
      type: VOCABULARY_BOOK_MESSAGE,
      action: 'upsert',
      input: {
        term: contentRequest.text,
        sourceLanguage: vocabularySourceLanguage(contentRequest),
        targetLanguage: contentRequest.targetLanguage,
        translation: answer,
        phonetic: wordCard.value?.phonetics.find(item => item.text)?.text || '',
        partOfSpeech: wordCard.value?.meanings.map(meaning => meaning.partOfSpeech) || [],
        context,
      },
    }) as VocabularyBookResponse<unknown>;
    if (!vocabularySaveGate.isCurrent(requestToken) || !isContentRequestCurrent(contentRequest)) return;
    if (!response?.success || !response.data) throw new Error(response?.success ? '保存失败' : response?.error?.message || '保存失败');
    const entryId = (response.data as {id?: unknown}).id;
    if (typeof entryId === 'string') await completeMaterialCapture(materialOperation, {kind: 'vocabulary', id: entryId, excerpt: contentRequest.text}, () => vocabularySaveGate.isCurrent(requestToken) && isContentRequestCurrent(contentRequest));
    if (!vocabularySaveGate.isCurrent(requestToken) || !isContentRequestCurrent(contentRequest)) return;
    isVocabularySaved.value = true;
    showNotice(wasSaved ? '已更新当前阅读上下文' : t('reading.sourceSaved'), 'open-vocabulary');
  } catch (cause) {
    if (vocabularySaveGate.isCurrent(requestToken)) showNotice(cause instanceof Error ? `保存失败：${cause.message}` : '保存失败，未写入单词本');
  } finally {
    if (vocabularySaveGate.isCurrent(requestToken)) vocabularyBusy.value = false;
  }
}

function showNotice(message: string, action: 'open-vocabulary' | 'open-local-tts' | null = null): void {
  noticeMessage.value = message;
  noticeAction.value = action;
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  noticeTimer = window.setTimeout(() => { noticeMessage.value = ''; noticeAction.value = null; }, 2600);
}

async function openNoticeSettings(): Promise<void> {
  const action = noticeAction.value, timer = noticeTimer;
  if (!action || !noticeMessage.value || componentDisposed) return;
  const isCurrent = () => !componentDisposed && noticeTimer === timer && noticeAction.value === action && Boolean(noticeMessage.value);
  try {
    const response = await browser.runtime.sendMessage({type: 'openOptionsPage',
      section: action === 'open-vocabulary' ? 'settings-vocabulary' : 'settings-selection'}) as {success?: unknown} | undefined;
    if (!isCurrent()) return;
    if (response?.success !== true) {
      showNotice('无法打开设置，请从扩展菜单打开设置后重试', action);
      return;
    }
    if (noticeTimer !== null) window.clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeMessage.value = '';
    noticeAction.value = null;
  } catch {
    if (isCurrent()) showNotice('无法打开设置，请从扩展菜单打开设置后重试', action);
  }
}

async function requestTranslation(request: SelectionContentRequest): Promise<void> {
  const text = request.text;
  const parts = snapshot.value!.parts;
  translationAbortController?.abort();
  const controller = new AbortController();
  translationAbortController = controller;
  const requestId = ++translationRequestId;
  isLoading.value = true;
  error.value = '';
  authenticationError.value = null;
  openingAuthenticationSettings.value = null;
  let requestedService: string | undefined;
  try {
    const context = props.selectionAdapter?.context && snapshot.value
      ? props.selectionAdapter.context(snapshot.value.range, text, 4000) : undefined;
    const options = {signal: controller.signal, sourceLanguage: request.sourceLanguage, targetLanguage: request.targetLanguage, serviceOverride: selectionSettings.value.service,
      ...(context ? {pageContext: context.text || text} : {})};
    requestedService = options.serviceOverride;
    const title = context?.title || document.title;
    const translated = parts.some(part => part.kind === 'code')
      ? await translateSelectionParts(parts, texts => translateTextBatch(texts, title, options))
      : [{kind: 'text' as const, text: await translateText(text, title, options)}];
    const result = translated.map(part => part.text).join('');
    if (requestId !== translationRequestId || !isResultSourceCurrent(request)) return;
    translationParts.value = translated;
    translationResult.value = result;
    translationAnswer.value = {...request, answer: result};
  } catch (cause) {
    if (requestId !== translationRequestId || !isResultSourceCurrent(request)) return;
    if (cause instanceof Error && cause.name === 'AbortError') return;
    console.error('Selection translation error:', cause);
    const kind = serializeTranslationError(cause).kind;
    error.value = kind === 'authentication' ? '密钥或权限无效' : '翻译失败，请重试';
    authenticationError.value = kind === 'authentication' ? {request, requestId, service: requestedService} : null;
  } finally {
    if (translationAbortController === controller) translationAbortController = null;
    if (requestId === translationRequestId) isLoading.value = false;
  }
}

function retryTranslation(): void {
  if (!snapshot.value) return;
  requestSelectionContent(snapshot.value.text);
}

async function sendWordCardRequest(word: string, targetLanguage: string, translateFields: boolean, signal: AbortSignal): Promise<{success?: boolean; data?: WordCardData | null}> {
  if (signal.aborted) throw new DOMException('Lookup aborted', 'AbortError');
  let onAbort!: () => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException('Lookup aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, {once: true});
    timer = setTimeout(() => reject(new Error('Dictionary lookup timed out')), 3_500);
  });
  try {
    return await Promise.race([browser.runtime.sendMessage({type: 'selectionWordLookup', word, targetLanguage, translateFields}), interrupted]) as {success?: boolean; data?: WordCardData | null};
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function retryWordCard(): void {
  const request = currentContentRequest.value;
  if (request) void requestWordCard(request);
}

async function requestWordCard(request: SelectionContentRequest): Promise<void> {
  const text = request.text;
  const word = normalizeEnglishWord(text);
  if (!word) return;
  const requestId = ++wordLookupRequestId;
  wordLookupAbortController?.abort();
  const controller = new AbortController();
  wordLookupAbortController = controller;
  isWordCardLoading.value = true;
  isWordCardSupportLoading.value = false;
  wordCardError.value = '';
  try {
    const response = await sendWordCardRequest(word, request.targetLanguage, false, controller.signal);
    if (requestId !== wordLookupRequestId || !isResultSourceCurrent(request)) return;
    if (!response?.success) throw new Error('Dictionary response unavailable');
    if (!response.data) {
      wordCard.value = null;
      dictionaryAnswer.value = null;
      wordCardError.value = '未查到词典条目，请检查拼写；也可能是名称或新词。';
    } else {
      wordCard.value = response.data;
      dictionaryAnswer.value = {...request, answer: dictionaryDefinitions(response.data, request.targetLanguage)};
      isWordCardLoading.value = false;
      schedulePositionUpdate();
      isWordCardSupportLoading.value = true;
      try {
        const enriched = await sendWordCardRequest(word, request.targetLanguage, true, controller.signal);
        if (requestId !== wordLookupRequestId || !isResultSourceCurrent(request)) return;
        if (enriched?.success && enriched.data) {
          wordCard.value = enriched.data;
          dictionaryAnswer.value = {...request, answer: dictionaryDefinitions(enriched.data, request.targetLanguage)};
        }
      } catch {
        // 辅助释义失败仍保留已经显示的词典原文，不重新进入整卡加载或未命中状态。
      }
    }
  } catch (cause) {
    if (requestId !== wordLookupRequestId || !isResultSourceCurrent(request)) return;
    console.warn('Selection word lookup unavailable:', cause);
    wordCard.value = null;
    dictionaryAnswer.value = null;
    wordCardError.value = '词典暂时未能返回结果，可稍后重查；译文会继续显示。';
  } finally {
    if (wordLookupAbortController === controller) wordLookupAbortController = null;
    if (requestId === wordLookupRequestId) {
      isWordCardLoading.value = false;
      isWordCardSupportLoading.value = false;
      schedulePositionUpdate();
    }
  }
}

function isCopied(kind: CopyKind): boolean {
  return copiedTextKind.value === kind;
}

function copyButtonTitle(kind: CopyKind): string {
  const label = kind === 'source' ? '原文' : '译文';
  return isCopied(kind) ? `已复制${label}` : `复制${label}`;
}

async function copyText(text: string, kind: CopyKind): Promise<void> {
  const value = text.trim();
  if (!value) return;
  const owner = translationRequestId;
  try {
    await navigator.clipboard.writeText(value);
    if (componentDisposed || owner !== translationRequestId) return;
    copiedTextKind.value = kind;
    copySuccess.value = true;
    if (copyTimer !== null) window.clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => {
      copySuccess.value = false;
      copiedTextKind.value = null;
      copyTimer = null;
    }, 1500);
  } catch (cause) { console.error('Copy selection text failed:', cause); }
}

function sourceLanguage(text: string): string {
  const requestedSource = currentContentRequest.value?.sourceLanguage ?? config.from;
  return normalizeSpeechLanguage(requestedSource === 'auto' ? detectlang(text) : requestedSource, 'en-US');
}
function translationLanguage(): string { return normalizeSpeechLanguage(currentContentRequest.value?.targetLanguage ?? effectiveTargetLanguage.value, 'zh-CN'); }
function speechLanguage(text: string, kind: AudioKind): string { return kind === 'translation' ? translationLanguage() : sourceLanguage(text); }

function selectVoice(language: string): SpeechSynthesisVoice | undefined {
  if (!('speechSynthesis' in window)) return undefined;
  const voices = window.speechSynthesis.getVoices();
  const normalized = language.toLowerCase();
  const exact = voices.filter(voice => voice.lang.toLowerCase() === normalized);
  const preferredNames = normalized.startsWith('en-')
    ? ['ava', 'aria', 'jenny', 'samantha', 'google us english', 'zira']
    : normalized.startsWith('zh-')
      ? ['xiaoxiao', 'ting-ting', 'tingting', 'huihui']
      : [];
  const preferred = exact.find(voice => preferredNames.some(name => voice.name.toLowerCase().includes(name)));
  if (preferred) return preferred;
  if (exact.length > 0) return exact[0];
  const base = language.split('-')[0]?.toLowerCase();
  return voices.find(voice => voice.lang.toLowerCase().startsWith(`${base}-`) || voice.lang.toLowerCase() === base);
}

function isCurrentAudio(kind: AudioKind, key = currentAudioText.value): boolean {
  return isPlaying.value && currentAudioKind.value === kind && currentAudioKey.value === key;
}
function audioLabel(kind: AudioKind): string {
  const label = kind === 'source' ? '原文' : kind === 'translation' ? '译文' : '单词';
  return isPreparingAudio.value && currentAudioKind.value === kind ? '停止生成语音' : isCurrentAudio(kind) ? `停止播放${label}` : `播放${label}`;
}
function wordAudioKey(pronunciation: WordPronunciation): string {
  return pronunciation.audio || pronunciation.text || wordCard.value?.word || selectedText.value;
}
function wordAudioLabel(pronunciation: WordPronunciation): string {
  const label = pronunciation.label || '单词发音';
  if (isPreparingAudio.value && currentAudioKind.value === 'word' && currentAudioKey.value === wordAudioKey(pronunciation)) return '停止生成语音';
  return isCurrentWordAudio(pronunciation) ? `停止播放${label}` : `播放${label}`;
}
function isCurrentWordAudio(pronunciation: WordPronunciation): boolean {
  return isCurrentAudio('word', wordAudioKey(pronunciation));
}

function releasePageAudio(): void {
  clearInterval(pageAudioProgressTimer);
  pageAudioProgressTimer = undefined;
  if (audio) { audio.onended = audio.onerror = audio.ontimeupdate = audio.onseeked = audio.onloadedmetadata = audio.ondurationchange = null; audio.pause(); audio.removeAttribute('src'); audio = null; }
  if (audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl = '';
  audioPosition.value = null;
}

function followPageAudio(nextAudio: HTMLAudioElement, text: string, cues: readonly SpeechCue[] = []): void {
  const tick = () => {
    if (audio !== nextAudio) return;
    audioPosition.value = parseSpeechPlaybackPosition({currentTime: nextAudio.currentTime, duration: nextAudio.duration});
    audioProgress.value = audioSpeechProgress(text, nextAudio.currentTime, nextAudio.duration, cues);
  };
  nextAudio.ontimeupdate = nextAudio.onseeked = nextAudio.onloadedmetadata = nextAudio.ondurationchange = tick;
  clearInterval(pageAudioProgressTimer);
  pageAudioProgressTimer = setInterval(tick, 100);
  tick();
}

function playbackTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

async function seekAudio(offsetSeconds: -5 | 5): Promise<void> {
  if (!isPlaying.value || isPreparingAudio.value || !audioPosition.value) return;
  if (audio) {
    const time = seekSpeechTime(audio.currentTime, audio.duration, offsetSeconds);
    if (time === null) return;
    try { audio.currentTime = time; audio.ontimeupdate?.(new Event('timeupdate')); }
    catch { showNotice('语音跳转失败，请重试'); }
    return;
  }
  const clientRequestId = ttsContentController.getState().activeClientRequestId;
  if (!clientRequestId) return;
  const generation = ttsContentController.currentGeneration();
  try {
    const response = await browser.runtime.sendMessage({type: 'selectionTtsSeek', clientRequestId, offsetSeconds}) as {success?: boolean};
    if (ttsContentController.isCurrentGeneration(generation) && !response?.success) showNotice('语音跳转失败，请重试');
  } catch {
    if (ttsContentController.isCurrentGeneration(generation)) showNotice('语音跳转失败，请重试');
  }
}

function stopAudio(notifyRemote = true): void {
  ttsContentController.stop(notifyRemote);
  releasePageAudio();
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  utterance = null;
  isPlaying.value = false;
  isPreparingAudio.value = false;
  audioProgress.value = null;
  audioTextOffset.value = 0;
  currentAudioKind.value = null;
  currentAudioText.value = '';
  currentAudioKey.value = '';
}

function stopAudioFromUi(): void { stopAudio(); }

function base64ToBlobUrl(audioBase64: string, contentType: string): string {
  const binary = atob(audioBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return URL.createObjectURL(new Blob([bytes], { type: contentType }));
}

interface EdgeSpeechResult {
  handled: boolean;
  error?: string;
  errorCode?: string;
}

async function playEdgeSpeech(text: string, language: string, kind: AudioKind, requestId: number): Promise<EdgeSpeechResult> {
  // 后台可能把播放权交给 Offscreen，也可能返回音频字节供当前页面播放；每一步都用代次校验
  // 丢弃旧请求，仅由当前代次在远端播放失败后继续降级到浏览器语音。
  const remoteRequest = ttsContentController.beginRemoteRequest();
  try {
    const response = await browser.runtime.sendMessage({
      type: 'selectionTts',
      text,
      language,
      clientRequestId: remoteRequest.clientRequestId,
    }) as {
      success?: boolean;
      audioBase64?: string;
      contentType?: string;
      timings?: unknown;
      transport?: 'offscreen' | 'page';
      errorCode?: unknown;
      error?: string;
    };
    const remoteResult = ttsContentController.completeRemoteRequest(remoteRequest, response);
    if (remoteResult === 'stale') return {handled: true};
    if (remoteResult === 'failed') return {
      handled: false,
      error: response.error,
      errorCode: typeof response.errorCode === 'string' ? response.errorCode : undefined,
    };
    if (remoteResult === 'offscreen') {
      currentAudioKind.value = kind;
      currentAudioText.value = text;
      isPlaying.value = true;
      return {handled: true};
    }
    if (!response.audioBase64) return {
      handled: false,
      errorCode: typeof response.errorCode === 'string' ? response.errorCode : undefined,
    };
    const nextAudioUrl = base64ToBlobUrl(response.audioBase64, response.contentType || 'audio/mpeg');
    const nextAudio = new Audio(nextAudioUrl);
    nextAudio.preload = 'auto';
    nextAudio.onended = () => { if (audio === nextAudio) { releasePageAudio(); stopAudio(); } };
    nextAudio.onerror = () => {
      if (audio !== nextAudio) return;
      releasePageAudio();
      isPlaying.value = false;
      currentAudioKind.value = null;
      currentAudioText.value = '';
    };
    audio = nextAudio;
    followPageAudio(nextAudio, text, parseSpeechCues(response.timings));
    audioUrl = nextAudioUrl;
    currentAudioKind.value = kind;
    currentAudioText.value = text;
    if (kind !== 'word') currentAudioKey.value = text;
    isPlaying.value = true;
    try {
      await nextAudio.play();
      return {handled: true};
    } catch (cause) {
      if (audio === nextAudio) releasePageAudio();
      if (ttsContentController.isCurrentGeneration(requestId)) {
        isPlaying.value = false;
        currentAudioKind.value = null;
        currentAudioText.value = '';
      }
      if (ttsContentController.isCurrentGeneration(requestId)) console.warn('Page audio unavailable, trying browser speech:', cause);
      return {handled: false};
    }
  } catch (cause) {
    const isCurrent = ttsContentController.rejectRemoteRequest(remoteRequest);
    if (isCurrent) console.warn('Edge TTS unavailable, trying browser speech:', cause);
    return {handled: !isCurrent};
  }
}

function playBrowserSpeech(text: string, language: string, kind: AudioKind): boolean {
  if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return false;
  try {
    const nextUtterance = new SpeechSynthesisUtterance(text);
    nextUtterance.lang = language;
    nextUtterance.voice = selectVoice(language) ?? null;
    nextUtterance.onboundary = event => {if (utterance === nextUtterance && (!event.name || event.name === 'word')) audioProgress.value = boundarySpeechProgress(text,event.charIndex,event.charLength);};
    nextUtterance.onend = () => { if (utterance === nextUtterance) stopAudio(); };
    nextUtterance.onerror = event => { if (utterance === nextUtterance && event.error !== 'canceled' && event.error !== 'interrupted') stopAudio(); };
    utterance = nextUtterance;
    currentAudioKind.value = kind;
    currentAudioText.value = text;
    if (kind !== 'word') currentAudioKey.value = text;
    isPlaying.value = true;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(nextUtterance);
    return true;
  } catch (cause) { console.warn('Browser speech synthesis unavailable:', cause); return false; }
}

async function playGoogleFallback(text: string, language: string, kind: AudioKind): Promise<void> {
  // 优先让 Offscreen 持有播放；只有仍属当前代次的请求才能退回页面音频 URL，避免停止后又响起。
  const requestId = ttsContentController.currentGeneration();
  const remoteRequest = ttsContentController.beginRemoteRequest();
  try {
    const response = await browser.runtime.sendMessage({
      type: 'selectionTtsGoogle',
      text,
      language,
      clientRequestId: remoteRequest.clientRequestId,
    }) as {
      success?: boolean;
      transport?: 'offscreen' | 'page';
    };
    const remoteResult = ttsContentController.completeRemoteRequest(remoteRequest, response);
    if (remoteResult === 'stale') return;
    if (remoteResult === 'offscreen') {
      currentAudioKind.value = kind;
      currentAudioText.value = text;
      isPlaying.value = true;
      return;
    }
  } catch (cause) {
    const isCurrent = ttsContentController.rejectRemoteRequest(remoteRequest);
    if (!isCurrent) return;
    console.warn('Offscreen Google TTS unavailable, trying page audio:', cause);
  }

  if (!ttsContentController.isCurrentGeneration(requestId)) return;
  const speechUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(language)}&client=tw-ob&q=${encodeURIComponent(text)}`;
  const nextAudio = new Audio(speechUrl);
  nextAudio.preload = 'auto';
  nextAudio.onended = () => { if (audio === nextAudio) { releasePageAudio(); stopAudio(); } };
  nextAudio.onerror = () => {
    if (audio !== nextAudio) return;
    console.warn('Fallback speech audio failed');
    releasePageAudio();
    stopAudio(false);
  };
  audio = nextAudio;
  followPageAudio(nextAudio, text);
  currentAudioKind.value = kind;
  currentAudioText.value = text;
  if (kind !== 'word') currentAudioKey.value = text;
  isPlaying.value = true;
  try {
    await nextAudio.play();
  } catch {
    if (audio === nextAudio) releasePageAudio();
    if (ttsContentController.isCurrentGeneration(requestId)) stopAudio(false);
  }
}

async function playExternalAudio(url: string, text: string, kind: AudioKind, key: string, requestId: number): Promise<boolean> {
  if (!ttsContentController.isCurrentGeneration(requestId)) return true;
  const nextAudio = new Audio(url);
  audio = nextAudio;
  currentAudioKind.value = kind;
  currentAudioText.value = text;
  currentAudioKey.value = key;
  isPlaying.value = true;
  followPageAudio(nextAudio, text);
  nextAudio.onended = () => { if (audio === nextAudio) stopAudio(); };
  nextAudio.onerror = () => {
    if (audio !== nextAudio) return;
    releasePageAudio();
    isPlaying.value = false;
  };
  try {
    await nextAudio.play();
    return true;
  } catch (cause) {
    if (audio === nextAudio) {
      releasePageAudio();
      isPlaying.value = false;
    }
    if (ttsContentController.isCurrentGeneration(requestId)) console.warn('Dictionary pronunciation audio unavailable:', cause);
    return false;
  }
}

async function toggleAudio(text: string, kind: AudioKind): Promise<void> {
  const cleanText = text.trim();
  if (!cleanText) return;
  if ((isCurrentAudio(kind) || isPreparingAudio.value && currentAudioKind.value === kind) && currentAudioText.value === cleanText) { stopAudio(); return; }
  stopAudio();
  const language = speechLanguage(cleanText, kind);
  const requestId = ttsContentController.currentGeneration();
  isPreparingAudio.value = true;
  audioTextOffset.value = text.length - text.trimStart().length;
  currentAudioKind.value = kind;
  currentAudioText.value = cleanText;
  currentAudioKey.value = cleanText;
  try {
    const edgeResult = await playEdgeSpeech(cleanText, language, kind, requestId);
    if (edgeResult.handled || !ttsContentController.isCurrentGeneration(requestId)) return;
    await fallbackSpeech(edgeResult, cleanText, language, kind);
  } finally {if (ttsContentController.isCurrentGeneration(requestId)) isPreparingAudio.value = false;}
}

async function fallbackSpeech(edgeResult: EdgeSpeechResult, text: string, language: string, kind: AudioKind): Promise<void> {
  if (edgeResult.errorCode === 'local-tts-model-not-downloaded') {
    showNotice(t('selectionTts.localModelNotDownloaded'), 'open-local-tts');
  } else if (edgeResult.errorCode === 'local-tts-language-unsupported') {
    showNotice(t('selectionTts.languageUnsupported'));
  }
  if (config.selectionTtsMode === 'local-only') {
    stopAudio(false);
    if (!edgeResult.errorCode) showNotice(edgeResult.error || '本地语音生成失败，请重试');
    return;
  }
  if (!playBrowserSpeech(text, language, kind)) await playGoogleFallback(text, language, kind);
}

function handleSelectionTtsState(message: unknown): true | undefined {
  const state = ttsContentController.matchRemoteState(message);
  if (!state) return undefined;

  const text = currentAudioText.value;
  const kind = currentAudioKind.value;
  const language = kind && text ? speechLanguage(text, kind) : '';
  if (state === 'progress') {
    const payload = message as {progress?:unknown; position?:unknown};
    audioProgress.value = parseSpeechProgress(payload.progress);
    audioPosition.value = parseSpeechPlaybackPosition(payload.position);
    return true;
  }
  if (state === 'ended' || state === 'stopped') {
    stopAudio(false);
    return true;
  }
  if (state === 'error') {
    const textOffset = audioTextOffset.value;
    stopAudio(false);
    if (config.selectionTtsMode === 'local-only') {
      const error = (message as {error?: string}).error;
      showNotice(error || '语音播放失败，请重试');
      return true;
    }
    audioTextOffset.value = textOffset;
    if (text && kind && !playBrowserSpeech(text, language, kind)) void playGoogleFallback(text, language, kind);
    return true;
  }
  return undefined;
}

async function toggleWordAudio(pronunciation: WordPronunciation): Promise<void> {
  const word = wordCard.value?.word || selectedWord.value || selectedText.value;
  const cleanText = word.trim();
  if (!cleanText) return;
  const key = wordAudioKey(pronunciation);
  if (isCurrentAudio('word', key) || isPreparingAudio.value && currentAudioKind.value === 'word' && currentAudioKey.value === key) { stopAudio(); return; }
  stopAudio();
  const requestId = ttsContentController.currentGeneration();
  isPreparingAudio.value = true;
  currentAudioKind.value = 'word';
  currentAudioText.value = cleanText;
  currentAudioKey.value = key;
  try {
    const externalAudio = pronunciation.audio;
    if (externalAudio && config.selectionTtsMode !== 'local-only') {
      const externalStarted = await playExternalAudio(externalAudio, cleanText, 'word', key, requestId);
      if (!ttsContentController.isCurrentGeneration(requestId)) return;
      if (externalStarted) return;
    }
    const edgeResult = await playEdgeSpeech(cleanText, 'en-US', 'word', requestId);
    if (!ttsContentController.isCurrentGeneration(requestId)) return;
    currentAudioKey.value = key;
    if (edgeResult.handled) return;
    await fallbackSpeech(edgeResult, cleanText, 'en-US', 'word');
    if (ttsContentController.isCurrentGeneration(requestId)) currentAudioKey.value = key;
  } finally {if (ttsContentController.isCurrentGeneration(requestId)) isPreparingAudio.value = false;}
}

function clearContextMenuSelection(): void {
  contextMenuSelection = null;
  contextMenuSourceRejected = false;
}

function isContextMenuInputTarget(target: EventTarget | null): boolean {
  let element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (element?.closest('input, textarea, select, button, [role="textbox"]')) return true;
  // contenteditable=false 的正文岛仍可选择；以最近的明确编辑边界为准，不能从外层祖先猜测。
  while (element) {
    const editable = element.getAttribute('contenteditable');
    if (editable !== null) return editable.trim().toLowerCase() !== 'false';
    element = element.parentElement;
  }
  return false;
}

function handleContextMenu(event: MouseEvent): void {
  if (!event.isTrusted) return;
  clearContextMenuSelection();
  // 输入控件的系统菜单可能保留正文旧 Range，触摸与鼠标都必须先核对来源。
  contextMenuSourceRejected = isInsideUi(event.target) || isContextMenuInputTarget(event.target);
  if (contextMenuSourceRejected) { cancelSelectionPresentation(); cancelTouchSelectionRead(); return; }
  // 移动端长按菜单与系统选区句柄共用同一次触摸。保留原生菜单，不冻结后续句柄调整。
  if (isTouchSelectionActive()) {
    isSelecting = false;
    cancelSelectionPresentation();
    scheduleTouchSelectionRead();
    return;
  }
  // 原生菜单接管这次选区交互，旧的延迟出卡和入口收起计时器不能在菜单期间清掉快照。
  cancelSelectionPresentation();
  const current = readSelectionSnapshot();
  if (!current) return;
  contextMenuSelection = {snapshot: current, rangeText: current.range.toString()};
  isSelecting = false;
  cancelSelectionLoss();
  suppressSelectionRead();
}

/** 浏览器菜单原文只用于核对本次已审核的选区，空白差异不改变内容身份。 */
function matchesContextMenuText(current: SelectionSnapshot, selectionText?: string): boolean {
  if (selectionText === undefined) return true;
  const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();
  return Boolean(selectionText.trim()) && normalize(current.nativeText) === normalize(selectionText);
}

function recoverContextMenuSelection(selectionText?: string): SelectionSnapshot | null {
  const captured = contextMenuSelection;
  if (!captured || !matchesContextMenuText(captured.snapshot, selectionText)) return null;
  try {
    const {range} = captured.snapshot;
    // 快照跨菜单等待仍须属于当前文档、保有原文并再次通过敏感区域规则；裸 selectionText 永远不作为翻译来源。
    if (!isSelectionRangeConnected(range) || range.toString() !== captured.rangeText
      || (props.selectionAdapter ? !props.selectionAdapter.acceptsRange(range) : shouldIgnoreSelection(range))) return null;
    return captured.snapshot;
  } catch {
    return null;
  }
}

/** 右键“翻译选中文本”：使用菜单绑定的可信选区出卡片，跳过触发方式与延迟设置。 */
function translateSelectionFromContextMenu(selectionText?: string): boolean {
  if (import.meta.env.BROWSER !== 'userscript' && contextMenuSourceRejected) return false;
  // 菜单打开时已冻结正文/代码片段和锚点，核对来源后复用，避免点击时再克隆 DOM 与测量选区。
  let next = import.meta.env.BROWSER !== 'userscript' ? recoverContextMenuSelection(selectionText) : null;
  if (!next) {
    const current = readSelectionSnapshot();
    next = current && matchesContextMenuText(current, selectionText) ? current : null;
  }
  if (!next) return false;
  suppressSelectionUntil = 0;
  isSelecting = false;
  applySelection(next, true, false, true);
  return showTooltip.value;
}

function closeTooltip(): void {
  const tooltip = tooltipRef.value;
  const root = tooltip?.getRootNode();
  const active = root && 'activeElement' in root ? root.activeElement : null;
  if (showTooltip.value && tooltip && active instanceof Element
    && (active === tooltip || tooltip.contains(active))) props.onFocusedCardDismiss?.();
  hideAll();
}
function hideAll(): void {
  clickSelectionFirstReadPending = false;
  clearReadingKeyboardFocus();
  cancelIndicatorTouch();
  touchOpenedSelection = null;
  invalidateFreeReadingEnable();
  if (import.meta.env.BROWSER !== 'userscript') clearContextMenuSelection();
  resetPopupGeometry();
  // 保留关闭时的选区身份，避免按钮保留原生选区时 pointerup / selectionchange 再次打开卡片。
  dismissedSelection = snapshot.value ?? readSelectionSnapshot() ?? dismissedSelection;
  lastTrustedSelectionInteractionAt = 0;
  touchSelectionActiveUntil = 0;
  cancelTouchSelectionRead();
  if (selectionFrame !== null) window.cancelAnimationFrame(selectionFrame);
  selectionFrame = null;
  cancelSelectionLoss();
  cancelSelectionPresentation();
  selectionSettledAt = 0;
  resetSelectionContentState(true);
  manuallyRequestedSelection.value = false;
  readingMode.value = false;
  readingSelection.value = null;
  showIndicator.value = false;
  showTooltip.value = false;
  snapshot.value = null;
  pendingSelectionShortcutUntil = 0;
  isVocabularySaved.value = false;
  vocabularyBusy.value = false;
}
function isInsideUi(target: EventTarget | null): boolean {
  if (target instanceof Element && target.id === 'fluent-read-share-card-container') return true;
  const node = target instanceof Node ? target : null;
  if (!node) return false;
  const host = document.getElementById('fluent-read-selection-translator-container');
  const root = node.getRootNode();
  return Boolean(node === host || host?.contains(node) || root === host?.shadowRoot);
}
function matchesSelectionModifierOnPointer(event: PointerEvent): boolean {
  const shortcut = selectionShortcut.value;
  if (!['Control', 'Alt', 'Shift'].includes(shortcut)) return false;
  const modifierState = {
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    key: shortcut === 'Control' ? 'Control' : shortcut === 'Alt' ? 'Alt' : 'Shift',
  };
  return matchesModifierOnlyHotkey(modifierState, shortcut);
}
function handlePointerDown(event: PointerEvent): void {
  if (!event.isTrusted) return;
  clickSelectionNotice.value = '';
  if (clickSelection.handlePointerDown(event)) {
    isSelecting = false;
    uiPointerInteraction = false;
    suppressSelectionRead();
    return;
  }
  if (import.meta.env.BROWSER === 'safari') prepareReadingCardPan(event);
  else clearReadingKeyboardFocus();
  // 第二根手指可以落在入口外；document capture 先撤销尚未完成的入口触摸。
  if (event.pointerType === 'touch') cancelIndicatorTouch();
  lastTrustedSelectionInteractionAt = Date.now();
  if (isInsideUi(event.target)) {
    if (import.meta.env.BROWSER === 'safari') readingFocusGestureAt = Date.now();
    touchSelectionActiveUntil = 0;
    cancelTouchSelectionRead();
    uiPointerInteraction = true;
    isSelecting = false;
    suppressSelectionRead();
    return;
  }
  uiPointerInteraction = false;
  readingPanelRef.value?.closeTools();
  if (import.meta.env.BROWSER !== 'userscript') clearContextMenuSelection();
  // 右键是打开原生菜单的准备动作；保留同一选区正在进行的请求和已完成结果。
  if (import.meta.env.BROWSER !== 'userscript' && event.button === 2) {
    isSelecting = false;
    pendingSelectionShortcutUntil = 0;
    suppressSelectionRead();
    return;
  }
  suppressSelectionUntil = 0;
  isSelecting = event.button === 0;
  pendingSelectionShortcutUntil = 0;
  hideAll();
  touchInteraction.value = event.pointerType === 'touch';
  if (touchInteraction.value) {
    touchSelectionActiveUntil = Date.now() + TOUCH_SELECTION_GRACE_MS;
    lastTrustedSelectionInteractionAt = Date.now();
  }
}
function handlePointerUp(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (clickSelection.handlePointerUp(event)) return;
  if (import.meta.env.BROWSER === 'safari') finishReadingCardPan(event);
  lastTrustedSelectionInteractionAt = Date.now();
  if (uiPointerInteraction || isInsideUi(event.target)) {
    if (import.meta.env.BROWSER === 'safari') readingFocusGestureAt = Date.now();
    uiPointerInteraction = false;
    isSelecting = false;
    suppressSelectionRead();
    return;
  }
  uiPointerInteraction = false;
  const completedSelectionGesture = isSelecting;
  isSelecting = false;
  if (!completedSelectionGesture || event.button !== 0) return;
  if (event.pointerType === 'touch') scheduleTouchSelectionRead();
  else scheduleSelectionRead(matchesSelectionModifierOnPointer(event) || selectionShortcutHeld);
}
function handlePointerCancel(event: PointerEvent): void {
  if (!event.isTrusted) return;
  if (import.meta.env.BROWSER === 'safari') finishReadingCardPan(event);
  cancelIndicatorTouch();
  if (uiPointerInteraction || isInsideUi(event.target)) {
    uiPointerInteraction = false;
    isSelecting = false;
    suppressSelectionRead();
    return;
  }
  isSelecting = false;
  // 浏览器接管长按选择/滚动时会派发 pointercancel。等待原生选区稳定，不阻止系统手势。
  if (event.pointerType === 'touch' && isTouchSelectionActive()) {
    scheduleTouchSelectionRead();
    return;
  }
  hideAll();
}
function cancelEntryDismiss(): void {
  if (entryDismissTimer !== null) window.clearTimeout(entryDismissTimer);
  entryDismissTimer = null;
}
function handlePointerMove(event: PointerEvent): void {
  if (clickSelection.active) return;
  if (event.isTrusted && event.pointerType === 'touch'
    && (import.meta.env.BROWSER !== 'safari' || !moveReadingCardPan(event))) clearReadingKeyboardFocus();
  trackIndicatorTouch(event);
  if (!event.isTrusted || event.pointerType !== 'mouse' || isSelecting || showTooltip.value
    || import.meta.env.BROWSER !== 'userscript' && (contextMenuSelection || contextMenuSourceRejected)
    || !selectionSettings.value.autoDismiss || !snapshot.value
    || triggerMode.value === 'shortcut' || triggerMode.value === 'contextMenu'
    || (!showIndicator.value && !pendingSelectionPresentation)) return;
  if (isInsideUi(event.target) || isInsideUi(document.activeElement)) { cancelEntryDismiss(); return; }
  const x = Number.parseFloat(indicatorStyle.value.left);
  const y = Number.parseFloat(indicatorStyle.value.top);
  // 允许从选区移向入口，也允许短暂离开后返回；不按静止时长强制消失。
  if (Math.hypot(event.clientX - x, event.clientY - y) <= 100 * popupScale.value) {
    cancelEntryDismiss();
    return;
  }
  if (entryDismissTimer !== null) return;
  entryDismissTimer = window.setTimeout(() => {
    entryDismissTimer = null;
    if (selectionSettings.value.autoDismiss && !showTooltip.value && !isSelecting
      && (import.meta.env.BROWSER === 'userscript' || !contextMenuSelection && !contextMenuSourceRejected)
      && !isInsideUi(document.activeElement)) hideAll();
  }, 600);
}
function handlePageCopy(event: ClipboardEvent): void {
  // 不拦截复制、不清除原生选区；卡片里的复制不参与页面的自动收起。
  if (event.isTrusted && selectionSettings.value.autoDismiss && !isInsideUi(event.target)) hideAll();
}
function handleSelectionChange(event: Event): void {
  if (clickSelection.active) return;
  if (readingMode.value && isInsideUi(document.activeElement)) return;
  if (!event.isTrusted) return;
  if (import.meta.env.BROWSER !== 'userscript' && (contextMenuSelection || contextMenuSourceRejected)) return;
  // 新的拖选/双击可以再次选中同一段；单纯点击保留旧选区的按钮不能解除关闭状态。
  if ((isSelecting || isTouchSelectionActive()) && dismissedSelection) {
    const current = readSelectionSnapshot();
    if (!current || !isSameSelection(dismissedSelection, current)) dismissedSelection = null;
  }
  if (isTouchSelectionActive() && !isSelectionReadSuppressed()) {
    cancelSelectionPresentation();
    showIndicator.value = false;
    scheduleTouchSelectionRead();
    return;
  }
  if (Date.now() - lastTrustedSelectionInteractionAt > TRUSTED_SELECTION_INTERACTION_GRACE_MS) return;
  if (!isSelectionReadSuppressed()) scheduleSelectionRead(selectionShortcutHeld);
}
// 焦点身份本身不豁免滚动；初次缩高与明确旋转各有固定800ms，普通 resize/scroll 不续期。
function clearReadingKeyboardFocus(event?: Event): void {
  if (readingKeyboardTimer !== undefined) window.clearTimeout(readingKeyboardTimer);
  readingKeyboardTimer = undefined;
  readingFocusGestureAt = undefined;
  if (import.meta.env.BROWSER === 'safari' && readingKeyboardFocus) readingKeyboardFocus.reveal = false;
  if (import.meta.env.BROWSER === 'safari') readingCardPan = undefined;
  if (import.meta.env.BROWSER === 'safari' && event && readingKeyboardFocus && readingKeyboardInputActive()
    && (event.type === 'input' || event.type === 'keydown' && [' ', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes((event as KeyboardEvent).key))) {
    const focus = readingKeyboardFocus, root = focus.card.getRootNode(), path = event.composedPath?.() ?? [];
    // document capture 早于输入框 stopPropagation；关闭 ShadowRoot 在 document 只暴露当前 host。
    if (event.target === focus.input || path.includes(focus.input)
      || 'host' in root && event.target === root.host && document.activeElement === root.host && path.includes(root.host as EventTarget)) {
      focus.expiresAt = 0;
      return;
    }
  }
  if (readingKeyboardFocus) window.removeEventListener('wheel', cancelReadingKeyboardWheel, true);
  readingKeyboardFocus = undefined;
}
function cancelReadingKeyboardWheel(event: WheelEvent): void {
  if (event.isTrusted) clearReadingKeyboardFocus();
}
function readingViewportLandscape(): boolean | undefined {
  const type = window.screen?.orientation?.type;
  if (type === 'landscape-primary' || type === 'landscape-secondary') return true;
  if (type === 'portrait-primary' || type === 'portrait-secondary') return false;
  const angle = window.orientation;
  if ([0, 90, -90, 180].includes(angle)) return Math.abs(angle) === 90;
}
function startReadingKeyboardPan(rotating: boolean): void {
  const focus = readingKeyboardFocus;
  if (!focus) return;
  if (readingKeyboardTimer !== undefined) window.clearTimeout(readingKeyboardTimer);
  focus.rotating = rotating;
  focus.expiresAt = Date.now() + 800;
  readingKeyboardTimer = window.setTimeout(() => {
    readingKeyboardTimer = undefined;
    if (readingKeyboardFocus === focus) focus.expiresAt = 0;
  }, 800);
}
function readingKeyboardInputActive(focus = readingKeyboardFocus): boolean {
  const root = focus?.card.getRootNode();
  return !!focus && selectionSettings.value.autoDismiss && readingMode.value && showTooltip.value
    && snapshot.value === focus.selection && tooltipRef.value === focus.card && focus.input.isConnected
    && focus.card.contains(focus.input) && !!root && 'activeElement' in root && root.activeElement === focus.input
    && focus.input.matches('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])');
}
function revealReadingInput(focus: NonNullable<typeof readingKeyboardFocus>, revision: number): void {
  if (readingKeyboardFocus !== focus || revision !== positionRevision || !focus.reveal) return;
  focus.reveal = false;
  if (Date.now() >= focus.expiresAt || !readingKeyboardInputActive(focus) || !isShortViewport()) return;
  restoreSelectionSource();
  if (!readingKeyboardInputActive(focus)) return;
  const card = focus.card, scale = popupScale.value, frame = card.getBoundingClientRect();
  const top = frame.top + card.clientTop * scale, bottom = top + card.clientHeight * scale;
  if (![top, bottom, scale, card.scrollTop, card.scrollHeight].every(Number.isFinite)
    || scale <= 0 || bottom <= top || card.scrollHeight <= card.clientHeight) return;
  // Safari 的 BCR 与 raw VV.offsetTop 不同原点；现有定位已把卡片限制在安全视口，只用自己的 client port。
  const input = focus.input.getBoundingClientRect();
  if (![input.top, input.bottom, input.height].every(Number.isFinite) || input.height <= 0 || input.height > bottom - top) return;
  const gap = Math.min(4, (bottom - top - input.height) / 2);
  const delta = input.bottom > bottom - gap ? input.bottom - bottom + gap : input.top < top + gap ? input.top - top - gap : 0;
  if (delta) card.scrollTop = Math.max(0, Math.min(card.scrollHeight - card.clientHeight, card.scrollTop + delta / scale));
}
function prepareReadingCardPan(event: PointerEvent): void {
  const focus = readingKeyboardFocus;
  clearReadingKeyboardFocus();
  if (!focus || !event.isPrimary || event.pointerType !== 'touch' || event.button !== 0 || !isInsideUi(event.target)
    || !readingKeyboardInputActive(focus) || !isShortViewport() || focus.card.clientHeight <= 0
    || focus.card.scrollHeight <= focus.card.clientHeight) return;
  const root = focus.card.getRootNode(), target = event.target;
  if (!(target instanceof Node && focus.card.contains(target)) && !('host' in root && target === root.host)) return;
  const viewport = window.visualViewport;
  if (!viewport || ![event.pointerId, event.clientX, event.clientY, window.scrollY, viewport.width, viewport.scale].every(Number.isFinite)
    || viewport.width <= 0 || viewport.scale <= 0 || Math.abs(viewport.scale - focus.scale) > 0.01) return;
  restoreSelectionSource();
  if (!readingKeyboardInputActive(focus)) return;
  focus.expiresAt = 0;
  readingKeyboardFocus = focus;
  readingCardPan = {focus, pointerId: event.pointerId, x: event.clientX, y: event.clientY, local: false,
    expiresAt: 0, width: viewport.width, scale: viewport.scale, scrollY: window.scrollY, travel: 0};
  window.addEventListener('wheel', cancelReadingKeyboardWheel, {capture: true, passive: true});
}
function moveReadingCardPan(event: PointerEvent): boolean {
  const pan = readingCardPan;
  const viewport = window.visualViewport;
  if (!pan || !pan.local || pan.pointerId !== event.pointerId || !event.isPrimary || !isInsideUi(event.target)
    || !readingKeyboardInputActive(pan.focus) || !isShortViewport() || !viewport
    || ![viewport.width, viewport.scale].every(Number.isFinite) || Math.abs(viewport.width - pan.width) > 1
    || Math.abs(viewport.scale - pan.scale) > 0.01) return false;
  const rect = pan.focus.card.getBoundingClientRect();
  if (![event.clientX, event.clientY].every(Number.isFinite) || event.clientX < rect.left || event.clientX > rect.right
    || event.clientY < rect.top || event.clientY > rect.bottom) return false;
  const dy = Math.abs(event.clientY - pan.y), dx = Math.abs(event.clientX - pan.x);
  if (!pan.expiresAt && dy >= 4 && dy > dx) {
    pan.expiresAt = Date.now() + 400;
    readingKeyboardTimer = window.setTimeout(() => {
      readingKeyboardTimer = undefined;
      if (readingCardPan === pan) readingCardPan = undefined;
    }, 400);
  }
  return true;
}
function finishReadingCardPan(event: PointerEvent): void {
  const pan = readingCardPan;
  if (!pan) return;
  if (pan.local && pan.expiresAt > Date.now() && pan.pointerId === event.pointerId && isInsideUi(event.target)) pan.pointerId = undefined;
  else clearReadingKeyboardFocus();
}
function handleReadingInputFocus(event: FocusEvent): void {
  dismissReadingToolsOutside(event);
  if (import.meta.env.BROWSER !== 'safari') return;
  const gestureAt = readingFocusGestureAt;
  clearReadingKeyboardFocus();
  const input = event.target, card = tooltipRef.value, viewport = window.visualViewport;
  const root = card?.getRootNode();
  if (!event.isTrusted || gestureAt === undefined || Date.now() - gestureAt > 500
    || !selectionSettings.value.autoDismiss || !readingMode.value || !showTooltip.value
    || !snapshot.value || !card || !(input instanceof HTMLElement) || !card.contains(input)
    || !input.matches('.fr-reading-followup input:not([disabled]):not([readonly]), .fr-reading-followup textarea:not([disabled]):not([readonly])')
    || !root || !('activeElement' in root) || root.activeElement !== input || !viewport
    || ![viewport.width, viewport.height, viewport.scale, window.innerWidth, window.innerHeight].every(value => Number.isFinite(value) && value > 0)) return;
  readingKeyboardFocus = {input, card, selection: snapshot.value, expiresAt: 0,
    width: viewport.width, height: viewport.height, scale: viewport.scale,
    landscape: readingViewportLandscape() ?? (window.innerWidth > window.innerHeight), rotating: false,
    revealViewport: viewportSize.value};
  // 仅此 Safari 自有焦点存续时观察主动 wheel；失焦/手势/关闭即释放，不拦截 legacy mousewheel。
  window.addEventListener('wheel', cancelReadingKeyboardWheel, {capture: true, passive: true});
  startReadingKeyboardPan(false);
}
function readingKeyboardViewport() {
  const focus = readingKeyboardFocus;
  if (!focus) return;
  const viewport = window.visualViewport;
  if (!readingKeyboardInputActive() || !viewport
    || ![viewport.width, viewport.height, viewport.scale, window.innerWidth, window.innerHeight].every(value => Number.isFinite(value) && value > 0)
    || Math.abs(viewport.scale - focus.scale) > 0.01) {
    clearReadingKeyboardFocus();
    return;
  }
  const explicitLandscape = readingViewportLandscape();
  const landscape = explicitLandscape ?? (window.innerWidth > window.innerHeight);
  if (landscape !== focus.landscape && (explicitLandscape !== undefined || Math.abs(viewport.width - focus.width) > 1)) {
    focus.landscape = landscape;
    startReadingKeyboardPan(true);
  }
  // Safari 可先报告方向和宿主页平移，再更新 VV 宽度；追上只刷新几何，不重开窗口。
  if (focus.rotating && Date.now() < focus.expiresAt) {
    focus.width = viewport.width;
    focus.height = viewport.height;
  }
  return {focus, viewport};
}
function handleReadingKeyboardScroll(event: Event): boolean {
  if (import.meta.env.BROWSER !== 'safari') return false;
  const target = event.target;
  if (target !== document && target !== window && !(target instanceof Element
    && (target === document.scrollingElement || target === document.documentElement || target === document.body))) return false;
  const pan = readingCardPan;
  if (pan) {
    const viewport = window.visualViewport;
    const travel = pan.travel + Math.abs(window.scrollY - pan.scrollY);
    if (!pan.local || Date.now() >= pan.expiresAt || !readingKeyboardInputActive(pan.focus) || !isShortViewport()
      || pan.focus.card.scrollHeight <= pan.focus.card.clientHeight || !viewport || Math.abs(viewport.width - pan.width) > 1
      || ![viewport.width, viewport.scale, travel].every(Number.isFinite) || Math.abs(viewport.scale - pan.scale) > 0.01 || travel > 2) {
      clearReadingKeyboardFocus();
      return false;
    }
    pan.travel = travel;
    pan.scrollY = window.scrollY;
  } else {
    // scroll 可能早于合帧的 viewport callback；同步读取同一实际几何，不增加监听或重试。
    const current = readingKeyboardViewport();
    if (!current) return false;
    const {focus, viewport} = current;
    if (Date.now() >= focus.expiresAt || Math.abs(viewport.width - focus.width) > 1
      || !focus.rotating && focus.height - viewport.height < 80) {
      clearReadingKeyboardFocus();
      return false;
    }
  }
  restoreSelectionSource();
  if (showTooltip.value) {
    viewportSize.value = getSafeVisualViewportRect();
    schedulePositionUpdate();
  }
  return true;
}
// 仅在扩展 UI 内拦住滚轮冒泡；document 级 wheel 会抑制 Chromium 对同节点派发 legacy mousewheel，导致旧播放器收不到音量手势。
function dismissReadingToolsOutside(event: Event): void {
  if (import.meta.env.BROWSER === 'safari' && readingCardPan
    && !(event.target instanceof Node && readingCardPan.focus.card.contains(event.target))) clearReadingKeyboardFocus();
  readingPanelRef.value?.dismissToolsOutside(event);
}
function dismissReadingToolsOnFocusOut(event: FocusEvent): void {
  clearReadingKeyboardFocus();
  const root = event.currentTarget as HTMLElement;
  if (!event.relatedTarget || !root.contains(event.relatedTarget as Node)) readingPanelRef.value?.closeTools();
}
function handleStudyToolbarFocus(event: FocusEvent): void {
  const toolbar = event.currentTarget;
  const button = event.target;
  if (!(toolbar instanceof HTMLElement) || !(button instanceof HTMLElement)
    || button.tagName !== 'BUTTON' || !toolbar.contains(button)) return;
  // 浏览器可能只露出聚焦按钮的一部分；仅滚动自己的导航，不移动正文或宿主页。
  const frame = toolbar.getBoundingClientRect();
  const item = button.getBoundingClientRect();
  const style = getComputedStyle(toolbar);
  const scale = popupScale.value;
  // 矩形是变换后的视口坐标，client/padding/scrollLeft 仍是布局像素。
  const left = frame.left + (toolbar.clientLeft + (parseFloat(style.paddingLeft) || 0)) * scale;
  const right = frame.left + (toolbar.clientLeft + toolbar.clientWidth - (parseFloat(style.paddingRight) || 0)) * scale;
  if (item.left < left) toolbar.scrollLeft -= (left - item.left) / scale;
  else if (item.right > right) toolbar.scrollLeft += (item.right - right) / scale;
}
function handleUiWheel(event: WheelEvent): void {
  suppressSelectionRead();
  if (event.ctrlKey) return; // 保留浏览器的缩放手势。
  // 短卡片或滚动到底时也不能把滚轮交给正文。仅监听自己的 UI，不碰页面的滚轮事件。
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    const style = getComputedStyle(node);
    // 鼠标滚轮也能浏览单行导航；只移动卡片自己的横向滚动区。
    if (node.matches('.fr-study-toolbar') && event.deltaX === 0 && event.deltaY !== 0
      && node.scrollWidth > node.clientWidth) {
      node.scrollLeft += event.deltaY;
      if (event.cancelable) event.preventDefault();
      return;
    }
    const canScrollY = event.deltaY !== 0 && /auto|scroll/.test(style.overflowY)
      && (event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop + node.clientHeight < node.scrollHeight - 1);
    const canScrollX = event.deltaX !== 0 && /auto|scroll/.test(style.overflowX)
      && (event.deltaX < 0 ? node.scrollLeft > 0 : node.scrollLeft + node.clientWidth < node.scrollWidth - 1);
    if (canScrollY || canScrollX) return;
    if (node === event.currentTarget) break;
  }
  if (event.cancelable) event.preventDefault();
}
function handleScroll(event: Event): void {
  if (isInsideUi(event.target)) {
    suppressSelectionRead();
    return;
  }
  if (import.meta.env.BROWSER !== 'userscript') clearContextMenuSelection();
  // 页面或其滚动容器移动后，未打开的入口不再跟随旧选区。
  // 选区读取可能还在下一帧或 selectionchange 队列中；连同显示计时器一起清理，
  // 避免滚动结束后才出现小点或卡片。拖选中的自动滚动仍由 pointerup 处理新选区。
  if (!showTooltip.value) {
    // 两点已完成但尚未读取原生 Selection 时，保留此前定位引发的同轮延迟滚动。
    if (clickSelectionFirstReadPending && selectionFrame !== null && !snapshot.value) return;
    if (!isSelecting && (snapshot.value || selectionFrame !== null
      || Date.now() - lastTrustedSelectionInteractionAt <= TRUSTED_SELECTION_INTERACTION_GRACE_MS)) hideAll();
    return;
  }
  if (handleReadingKeyboardScroll(event)) return;
  if (readingMode.value && readingEvidenceScrollFrame !== undefined) { schedulePositionUpdate(); return; }
  if (selectionSettings.value.autoDismiss) { hideAll(); return; }
  schedulePositionUpdate();
}
function isClickSelectionEditingEvent(event: KeyboardEvent): boolean {
  return (event.composedPath?.() ?? [event.target]).some(target => target instanceof Element
    && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
}
function handleKeydown(event: KeyboardEvent): void {
  if (!event.isTrusted || (event.target instanceof Element && event.target.id === 'fluent-read-share-card-container')) return;
  if (import.meta.env.BROWSER === 'safari' && readingCardPan) clearReadingKeyboardFocus();
  if (import.meta.env.BROWSER !== 'userscript') clearContextMenuSelection();
  if (['Escape', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)) clearReadingKeyboardFocus(event);
  lastTrustedSelectionInteractionAt = Date.now();
  if (isInsideUi(event.target)) {
    if (import.meta.env.BROWSER === 'safari') readingFocusGestureAt = Date.now();
    suppressSelectionRead();
    if (event.key === 'Escape' && readingPanelRef.value?.dismissTools()) { event.preventDefault(); event.stopPropagation(); return; }
    if (event.key === 'Escape' && snapshot.value) { event.preventDefault(); event.stopPropagation(); closeTooltip(); }
    return;
  }
  if (clickSelectionFirstReadPending && (event.key === 'Escape' || isClickSelectionEditingEvent(event))) { hideAll(); return; }
  if (event.key === 'Escape' && clickSelection.active) {
    event.preventDefault();
    event.stopPropagation();
    clickSelection.cancel();
    return;
  }
  if (event.key === 'Escape' && snapshot.value) { hideAll(); return; }
  if (event.repeat || event.isComposing) return;
  if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) { clickSelection.cancel(); return; }
  if (!props.selectionAdapter && matchesClickSelectionShortcut(event, config)) {
    // 开放 Shadow DOM 的键盘事件会把 target 重定向到 host；仅为两点入口审核原始编辑路径。
    if (isClickSelectionEditingEvent(event)) { clickSelection.cancel(); return; }
    event.preventDefault();
    event.stopPropagation();
    if (!clickSelection.active) hideAll();
    clickSelection.toggle();
    return;
  }
  if (clickSelection.active) {
    // 保留组合键的修饰键与普通翻页；其他主键退出本轮，让后续阅读动作独占指针。
    if (!['Control', 'Alt', 'Shift', 'Meta', 'PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(event.key)) clickSelection.cancel();
    return;
  }
  const matchesSelectionShortcut = matchesConfiguredHotkey(event, selectionShortcutConfig.value, selectionSettings.value.customHotkey);
  if (!matchesSelectionShortcut) return;
  selectionShortcutHeld = true;
  const currentSelection = readSelectionSnapshot();
  if (currentSelection) {
    if (isSelectionInTargetLanguage(currentSelection.text)) { hideAll(); return; }
    event.preventDefault();
    event.stopPropagation();
    applySelection(currentSelection, true);
    return;
  }
  if (!snapshot.value) {
    scheduleSelectionRead(true);
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  scheduleSelectionPresentation('tooltip');
}

function handleKeyup(): void {
  selectionShortcutHeld = false;
}

function handleWindowBlur(): void {
  clearReadingKeyboardFocus();
  cancelIndicatorTouch();
  stopPopupGesture();
  cancelReadingHover();
  selectionShortcutHeld = false;
  pendingSelectionShortcutUntil = 0;
  if (!showTooltip.value && !isTouchSelectionActive()
    && (import.meta.env.BROWSER === 'userscript' || !contextMenuSelection && !contextMenuSourceRejected)) hideAll();
}

function handlePageVisibility(): void {
  if (document.visibilityState !== 'hidden') return;
  clearReadingKeyboardFocus();
  cancelIndicatorTouch();
  stopPopupGesture();
  cancelTouchSelectionRead();
  touchSelectionActiveUntil = 0;
  isSelecting = false;
  uiPointerInteraction = false;
  selectionShortcutHeld = false;
  pendingSelectionShortcutUntil = 0;
  cancelReadingHover();
  cancelSelectionPresentation();
  if (selectionFrame !== null) window.cancelAnimationFrame(selectionFrame);
  selectionFrame = null;
  if (!showTooltip.value) hideAll();
}

function restoreSelectionSource(): void {
  if (document.visibilityState === 'hidden') return;
  const current = snapshot.value;
  // bfcache/后台期间正文可能被替换；不再展示失去来源的结果或恢复旧的自动触发。
  if (!current) return;
  try {
    if (isSelectionRangeConnected(current.range)
      && (typeof current.rangeText !== 'string' || current.range.toString() === current.rangeText)
      && (props.selectionAdapter ? props.selectionAdapter.acceptsRange(current.range) : !shouldIgnoreSelection(current.range))) return;
  } catch {
    // 已销毁的来源适配器与失效 Range 同样按来源丢失处理，不能阻断页面恢复。
  }
  hideAll();
}

// 内容装配层恢复被网页移除的 host 时，先检查组件持有的原文快照。
defineExpose({revalidateSource: restoreSelectionSource});

function handlePageHide(): void {
  isSelecting = false;
  uiPointerInteraction = false;
  hideAll();
}

function handleSelectionSettingsMessage(message: unknown): undefined {
  if (!message || typeof message !== 'object') return undefined;
  const type = (message as { type?: unknown }).type;
  // 后台已核对专用凭据对应的模型输入；content 只接收无值事件，不能获取密钥或摘要。
  if (type === 'fluentReadReadingModelInputsChanged') {
    readingModelRevision.value += 1;
    return undefined;
  }
  if (type !== 'updateSelectionTranslatorSettings' && type !== 'updateSelectionTranslatorMode') return undefined;
  selectionConfigVersion.value += 1;
  return undefined;
}

function handleVocabularyBookChanged(message: unknown): undefined {
  if (!message || typeof message !== 'object' || (message as {type?: unknown}).type !== VOCABULARY_BOOK_CHANGED_MESSAGE) return undefined;
  const request = currentContentRequest.value;
  if (request && isWordSelection.value) void refreshVocabularySaved(request);
  return undefined;
}

onMounted(() => {
  updateTheme();
  systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
  systemThemeMedia.addEventListener('change', updateTheme);
  runtimeMessageUnsubscribers.push(
    addRuntimeMessageListener(browser.runtime, handleSelectionSettingsMessage),
    addRuntimeMessageListener(browser.runtime, handleVocabularyBookChanged),
    addRuntimeMessageListener(browser.runtime, handlePageZoomChanged),
  );
  void requestPageZoom();
  releaseContextMenuHandler = setSelectionContextMenuHandler(translateSelectionFromContextMenu);
  unsubscribeConfig = subscribeConfig(() => { selectionConfigVersion.value += 1; });
  unsubscribeSelectionSource = props.selectionAdapter?.subscribeInvalidation?.(hideAll) ?? null;
  document.addEventListener('pointerdown', handlePointerDown, true);
  document.addEventListener('pointerup', handlePointerUp, true);
  document.addEventListener('pointercancel', handlePointerCancel, true);
  document.addEventListener('pointermove', handlePointerMove, {capture: true, passive: true});
  document.addEventListener('copy', handlePageCopy, true);
  if (import.meta.env.BROWSER !== 'userscript') document.addEventListener('contextmenu', handleContextMenu, true);
  document.addEventListener('selectionchange', handleSelectionChange);
  document.addEventListener('keydown', handleKeydown, true);
  document.addEventListener('keyup', handleKeyup, true);
  window.addEventListener('blur', handleWindowBlur);
  runtimeMessageUnsubscribers.push(addRuntimeMessageListener(browser.runtime, handleSelectionTtsState));
  window.addEventListener('scroll', handleScroll, true);
  unsubscribeVisualViewport = observeVisualViewport(handleViewportResize);
  document.addEventListener('visibilitychange', handlePageVisibility);
  document.addEventListener('visibilitychange', restoreSelectionSource);
  window.addEventListener('pagehide', handlePageHide);
  window.addEventListener('pageshow', restoreSelectionSource);
  watch(tooltipRef, (tooltip) => {
    stopPopupGesture();
    tooltipResizeObserver?.disconnect();
    tooltipResizeObserver = null;
    if (!tooltip || typeof ResizeObserver === 'undefined') return;
    tooltipResizeObserver = new ResizeObserver(schedulePositionUpdate);
    tooltipResizeObserver.observe(tooltip);
  }, { flush: 'post' });
  watch(() => JSON.stringify(readingPreferences.value), (nextPreferences, previousPreferences) => {
    // 水合时使用最新且仍有资格的偏好；保存的准确回声与失败回滚保留选区，其他偏好更新关闭旧请求。
    const operation = freeReadingEnable;
    if (operation && !operation.cancelled && showTooltip.value && snapshot.value === operation.selection
      && ((!operation.nextPreferences && canEnableFreeReading.value)
        || (previousPreferences === operation.previousPreferences && nextPreferences === operation.nextPreferences)
        || (previousPreferences === operation.nextPreferences && nextPreferences === operation.previousPreferences))) return;
    hideAll();
  });
  watch(() => [
    selectionSettings.value.theme,
    selectionSettings.value.trigger,
    selectionSettings.value.customHotkey,
    selectionSettings.value.delay,
    selectionSettings.value.mode,
    selectionSettings.value.to,
    selectionSettings.value.from,
    selectionSettings.value.service,
    selectionSettings.value.model,
    config.vocabularyBookEnabled,
    selectionSettings.value.bidirectional,
  ] as const, (nextSettings, previousSettings) => {
    const themeChanged = !previousSettings || nextSettings[0] !== previousSettings[0];
    const triggerChanged = !previousSettings
      || nextSettings[1] !== previousSettings[1]
      || nextSettings[2] !== previousSettings[2];
    const delayChanged = !previousSettings || nextSettings[3] !== previousSettings[3];
    const languageChanged = !previousSettings
      || nextSettings[5] !== previousSettings[5]
      || nextSettings[6] !== previousSettings[6];
    const translationProviderChanged = !previousSettings
      || nextSettings[7] !== previousSettings[7]
      || nextSettings[8] !== previousSettings[8];
    const directionEntryChanged = !previousSettings || nextSettings[10] !== previousSettings[10];
    if (themeChanged) updateTheme();
    if (!snapshot.value) return;
    if (languageChanged) manuallyRequestedSelection.value = false;
    if (languageChanged && readingMode.value) { hideAll(); return; }
    if ((languageChanged || directionEntryChanged) && !manuallyRequestedSelection.value
      && (shouldSkipChineseSelection(snapshot.value.text, config.to)
      && !(selectionSettings.value.bidirectional && selectionReverseTarget(snapshot.value.text, config.to, config.from))
      || (!readingEnabled.value && isSelectionInTargetLanguage(snapshot.value.text)))) { hideAll(); return; }
    if (languageChanged || translationProviderChanged || directionEntryChanged) resetSelectionContentState();
    if (triggerChanged) {
      const nextPresentation = reconcileSelectionPresentation({
        showIndicator: showIndicator.value,
        showTooltip: showTooltip.value,
      }, triggerMode.value, true);
      cancelSelectionPresentation();
      showIndicator.value = false;
      showTooltip.value = false;
      if (nextPresentation.showTooltip) scheduleSelectionPresentation('tooltip');
      else if (nextPresentation.showIndicator) scheduleSelectionPresentation('indicator');
      return;
    }
    if (delayChanged && pendingSelectionPresentation) {
      scheduleSelectionPresentation(pendingSelectionPresentation);
      return;
    }
    if (languageChanged || translationProviderChanged || directionEntryChanged) {
      if (showTooltip.value && !readingMode.value) void requestSelectionContent(snapshot.value.text);
    }
    if (previousSettings && nextSettings[9] !== previousSettings[9] && showTooltip.value && isWordSelection.value) {
      const request = currentContentRequest.value;
      if (request) void refreshVocabularySaved(request);
    }
  });
});

onBeforeUnmount(() => {
  componentDisposed = true;
  clickSelectionFirstReadPending = false;
  clickSelection.dispose();
  clearReadingKeyboardFocus();
  cancelIndicatorTouch();
  touchOpenedSelection = null;
  invalidateFreeReadingEnable();
  disposeReadingEvidence();
  zoomRequestGeneration += 1;
  releaseContextMenuHandler?.();
  releaseContextMenuHandler = null;
  stopPopupGesture();
  cancelTouchSelectionRead();
  unsubscribeVisualViewport?.();
  unsubscribeVisualViewport = null;
  if (selectionFrame !== null) window.cancelAnimationFrame(selectionFrame);
  selectionFrame = null;
  cancelPositionUpdate();
  // 悬停延迟可能跨过卸载；卸载后不能再按旧选区打开阅读卡片。
  cancelReadingHover();
  cancelSelectionLoss();
  cancelSelectionPresentation();
  clearCopyFeedback();
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  systemThemeMedia?.removeEventListener('change', updateTheme);
  runtimeMessageUnsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
  unsubscribeConfig?.();
  unsubscribeConfig = null;
  unsubscribeSelectionSource?.();
  unsubscribeSelectionSource = null;
  tooltipResizeObserver?.disconnect();
  tooltipResizeObserver = null;
  document.removeEventListener('pointerdown', handlePointerDown, true);
  document.removeEventListener('pointerup', handlePointerUp, true);
  document.removeEventListener('pointercancel', handlePointerCancel, true);
  document.removeEventListener('pointermove', handlePointerMove, true);
  document.removeEventListener('copy', handlePageCopy, true);
  if (import.meta.env.BROWSER !== 'userscript') document.removeEventListener('contextmenu', handleContextMenu, true);
  document.removeEventListener('selectionchange', handleSelectionChange);
  document.removeEventListener('keydown', handleKeydown, true);
  document.removeEventListener('keyup', handleKeyup, true);
  window.removeEventListener('blur', handleWindowBlur);
  window.removeEventListener('scroll', handleScroll, true);
  document.removeEventListener('visibilitychange', handlePageVisibility);
  document.removeEventListener('visibilitychange', restoreSelectionSource);
  window.removeEventListener('pagehide', handlePageHide);
  window.removeEventListener('pageshow', restoreSelectionSource);
  resetSelectionContentState(true);
  if (import.meta.env.BROWSER !== 'userscript') clearContextMenuSelection();
});
</script>

<style scoped>
.fr-selection-translator-root { position: fixed; inset: 0; z-index: 2147483647; width: 100vw; height: 100vh; pointer-events: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #25252a; }
.fr-click-selection-hint { position: fixed; top: max(12px, env(safe-area-inset-top)); left: 50%; transform: translateX(-50%); max-width: calc(100vw - 24px); padding: 7px 12px; border: 1px solid #e5d6de; border-radius: 8px; background: #fff; color: #694157; box-shadow: 0 2px 10px #3021321a; font-size: 12px; line-height: 1.5; text-align: center; pointer-events: none; }
.fr-click-selection-hint--dark { background: #312b33; border-color: #64505e; color: #f2cede; }
.fr-selection-indicator, .fr-translation-tooltip, .fr-copy-success-toast, .fr-action-toast { pointer-events: auto; }
.fr-selection-indicator { position: fixed; width: 22px; height: 22px; padding: 0; border: 1px solid #f3c3d2; border-radius: 7px; transform: translate(-50%, -50%); background: #fff; color: #d83160; box-shadow: 0 2px 8px rgba(40, 35, 43, .2); cursor: pointer; transition: transform .14s ease, box-shadow .14s ease; }
.fr-selection-indicator--dot { width: 8px; height: 8px; border:0; border-radius:50%; background:#ef4b86; }
.fr-selection-indicator--dot .fr-selection-indicator-glyph { display: none; }
.fr-selection-indicator:hover, .fr-selection-indicator:focus-visible { transform: translate(-50%, -50%) scale(1.1); color:#b8416b; border-color:#d889a5; box-shadow:0 2px 7px rgba(40, 35, 43, .18); outline:2px solid #f0cede; outline-offset:2px; }
.fr-selection-indicator-glyph { font-size: 12px; font-weight: 700; line-height: 1; }
.fr-translation-tooltip, .fr-translation-tooltip * { box-sizing: border-box; }
.fr-translation-tooltip { position: fixed; display: flex; flex-direction: column; width: min(388px, calc(100vw - 24px)); max-height: min(520px, calc(100vh - 20px)); overflow: hidden; border: 1px solid rgba(35, 35, 43, .12); border-radius: 11px; background: #fff; box-shadow: 0 5px 20px rgba(35, 33, 43, .12); -webkit-user-select: none; user-select: none; }
.fr-translation-tooltip > .fr-study-navigation { cursor: move; }
.fr-popup-manipulating, .fr-popup-manipulating * { cursor: grabbing !important; user-select: none !important; }
.fr-popup-resize-handle { position: absolute; z-index: 2; touch-action: none; }
.fr-popup-resize-n, .fr-popup-resize-s { left: 12px; right: 12px; height: 6px; cursor: ns-resize; }
.fr-popup-resize-n { top: 0; } .fr-popup-resize-s { bottom: 0; }
.fr-popup-resize-e, .fr-popup-resize-w { top: 12px; bottom: 12px; width: 6px; cursor: ew-resize; }
.fr-popup-resize-e { right: 0; } .fr-popup-resize-w { left: 0; }
.fr-popup-resize-ne, .fr-popup-resize-nw, .fr-popup-resize-se, .fr-popup-resize-sw { width: 12px; height: 12px; }
.fr-popup-resize-ne { top: 0; right: 0; cursor: nesw-resize; }
.fr-popup-resize-nw { top: 0; left: 0; cursor: nwse-resize; }
.fr-popup-resize-se { bottom: 0; right: 0; cursor: nwse-resize; }
.fr-popup-resize-sw { bottom: 0; left: 0; cursor: nesw-resize; }
.fr-popup-resize-se::after { content: ''; position: absolute; right: 3px; bottom: 3px; width: 5px; height: 5px; border-right: 2px solid #95858d; border-bottom: 2px solid #95858d; }
.fr-reading-tooltip { display: flex; flex-direction: column; height: auto; overflow: visible; }
.fr-reading-tooltip > .fr-reading-content { display: flex; flex-direction: column; flex: 1; min-height: 0; max-height: none; overflow: hidden; padding: 0; }
/* 自动卡用内在高度收拢；达到外框上限后将收缩量传给真正的阅读滚动区。 */
.fr-reading-content > :deep(.fr-reading) { flex: 1; height: auto; }
.fr-pos-label { display:flex; gap:6px; align-items:center; }
.fr-study-navigation { flex: none; display: flex; align-items: center; gap: 3px; padding: 4px 8px; border-bottom: 1px solid var(--fr-border, #eeedf0); }
.fr-tooltip-brand-icon { display:block; flex:none; width:18px; height:18px; border-radius:4px; object-fit:contain; opacity:1; pointer-events:none; }
.fr-study-toolbar { flex: 1; min-width: 0; display: flex; flex-wrap: nowrap; overflow-x: auto; overscroll-behavior: contain; scrollbar-width: thin; gap: 3px; }
.fr-study-reading-tools { flex: none; }
.fr-study-toolbar button { flex:none; white-space:nowrap; font:inherit; font-size:11px; border:0; background:transparent; color:#62616c; border-radius:5px; padding:5px 8px; cursor:pointer; }
.fr-study-toolbar button[aria-pressed=true], .fr-study-toolbar button:hover, .fr-study-toolbar button:focus-visible { background:#f4f0f3; color:#8e4867; outline:1px solid #dcc3d0; }
.fr-dark-theme .fr-study-navigation { border-color:#4d404a; }
.fr-dark-theme .fr-study-toolbar button { background:transparent; color:#cbc2c9; }
.fr-dark-theme .fr-study-toolbar button[aria-pressed=true], .fr-dark-theme .fr-study-toolbar button:hover { background:#443541; color:#efbdd2; }
.fr-tooltip-actions { flex: none; display: flex; align-items: center; gap: 2px; }
.fr-action-btn, .fr-close-btn, .fr-text-audio-btn, .fr-playing-status button { border: 0; background: transparent; color: #777780; cursor: pointer; }
.fr-action-btn { display: grid; width: 26px; height: 26px; place-items: center; border-radius: 6px; }
.fr-action-btn svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.fr-action-btn:hover, .fr-action-btn:focus-visible { background: #f7eaf0; color: #d63f76; outline: none; }
.fr-action-btn:disabled { cursor: not-allowed; opacity: .38; }
.fr-vocabulary-btn.fr-saved { color: #ef4b86; }
.fr-vocabulary-btn.fr-saved svg { fill: currentColor; stroke: currentColor; }
.fr-close-btn { width: 26px; height: 26px; font-size: 19px; line-height: 1; border-radius: 6px; }
.fr-close-btn:hover, .fr-close-btn:focus-visible { background: #f1f1f5; color: #303038; outline: none; }
.fr-tooltip-content { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 12px 14px; scrollbar-color: rgba(108, 105, 112, .4) transparent; scrollbar-width: thin; }
.fr-translation-container { display: grid; gap: 9px; }
.fr-loading-state, .fr-error-state { display: flex; align-items: center; justify-content: center; gap: 9px; min-height: 80px; color: #777780; font-size: 13px; }
.fr-error-state { flex-direction: column; color: #c43b63; }
.fr-error-state button { border: 1px solid currentColor; border-radius: 7px; padding: 4px 10px; background: transparent; color: inherit; cursor: pointer; }
.fr-error-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; min-width: 0; max-width: 100%; }
.fr-error-actions button { max-width: 100%; }
.fr-error-actions button:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.fr-error-actions button:disabled { opacity: .55; cursor: default; }
.fr-loading-spinner { width: 18px; height: 18px; border: 2px solid #f5bfd3; border-top-color: #ef4b86; border-radius: 50%; animation: fr-spin .7s linear infinite; }
.fr-loading-spinner.fr-static { animation: none; }
@keyframes fr-spin { to { transform: rotate(360deg); } }
.fr-word-learning-card { padding: 1px 1px 0; color: #39363d; }
.fr-word-card-loading { display: flex; align-items: center; gap: 7px; min-height: 22px; margin-bottom: 8px; color: #77747c; font-size: 11px; line-height: 1.5; }
.fr-word-card-loading .fr-loading-spinner { flex: 0 0 auto; width: 12px; height: 12px; }
.fr-word-support-loading { margin: 4px 0; color: #77747c; font-size: 11px; line-height: 1.5; }
.fr-word-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 0; }
.fr-word-heading > div:first-child { min-width: 0; }
.fr-word-heading h3 { margin: 0; color: #292832; font-size: 27px; font-weight: 700; letter-spacing: -.035em; line-height: 1.08; overflow-wrap: anywhere; user-select: text; }
.fr-word-normalized { display: block; margin-top: 5px; color: #aaa1a6; font-size: 10px; }
.fr-word-heading-actions { display: flex; flex: none; align-items: center; gap: 4px; }
.fr-word-heading-audio { background: #f8f5f6; color: #9b8d94; }
.fr-word-pronunciations { display: flex; flex-wrap:wrap; gap: 4px 14px; margin-top: 7px; padding-bottom: 8px; border-bottom: 1px solid #eeecee; }
.fr-word-pronunciation { display: flex; align-items: center; gap: 5px; min-height: 26px; padding: 0; }
.fr-word-pronunciation:last-child { border-bottom: 0; }
.fr-word-pronunciation-label { color: #8d7a83; font-size: 10px; font-weight: 500; }
.fr-word-ipa { color: #4a454c; font-family: Georgia, "Times New Roman", serif; font-size: 14px; }
.fr-word-pronunciation .fr-text-audio-btn { width:24px; height:24px; }
.fr-word-translation { display:flow-root; margin-top: 9px; padding: 0 0 10px; border-bottom: 1px solid #eeecee; color: #3a363d; }
.fr-word-translation-header { float:inline-end; margin-inline-start:8px; }
.fr-word-translation .fr-text-label { margin: 0; }
.fr-word-translation pre { overflow-wrap: anywhere; margin: 0; white-space: pre-wrap; word-break: break-word; font: inherit; font-size: 16px; font-weight: 600; line-height: 1.6; user-select: text; }
.fr-word-translation-loading, .fr-word-empty { margin-top: 12px; color: #9a9298; font-size: 12px; }
.fr-word-meaning-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; color: #9a9298; font-size: 11px; font-weight: 700; }
.fr-word-meaning-toolbar button { border: 0; padding: 3px 0; background: transparent; color: #9e5d71; cursor: pointer; font: inherit; font-weight: 600; }
.fr-word-meaning-toolbar button:hover, .fr-word-meaning-toolbar button:focus-visible { color: #7f4156; text-decoration: underline; outline: none; }
.fr-word-meanings { display: grid; gap: 16px; margin-top: 14px; }
.fr-word-meaning-toolbar + .fr-word-meanings { margin-top: 8px; }
.fr-word-meaning { color: #454149; font-size: 12.5px; line-height: 1.52; }
.fr-word-meaning > strong { display: inline-flex; padding: 3px 7px; border: 1px solid #ead8de; border-radius: 6px; background: #fbf5f6; color: #9e5d71; font-size: 10px; font-weight: 700; }
.fr-word-meaning ol { margin: 7px 0 0; padding: 0; list-style: none; counter-reset: definition; }
.fr-word-meaning li { position: relative; padding-left: 21px; }
.fr-word-meaning li::before { position: absolute; top: 0; left: 0; width: 14px; color: #b5adb2; content: counter(definition); counter-increment: definition; font-size: 11px; text-align: right; }
.fr-word-meaning li + li { margin-top: 9px; }
.fr-word-definition-en, .fr-word-example-en { display: block; }
.fr-word-definition-zh, .fr-word-example-zh { display: block; margin-top: 3px; color: #9a7f89; font-size: 11.5px; }
.fr-word-meaning em { display: block; margin-top: 4px; padding-left: 8px; border-left: 2px solid #ead8de; color: #74676d; font-size: 11px; font-style: normal; line-height: 1.45; }
.fr-word-card-footer { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 8px; margin-top: 16px; padding-top: 10px; border-top: 1px solid #eeecee; color: #aaa1a6; font-size: 10px; }
.fr-word-card-footer a { color: #9e5d71; text-decoration: none; }
.fr-word-card-footer a:hover, .fr-word-card-footer a:focus-visible { text-decoration: underline; }
.fr-word-fallback-note, .fr-inline-error { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; color: #a56578; font-size: 11px; }
.fr-word-fallback-note { padding: 6px 8px; border-radius: 7px; background: #fff8fa; }
.fr-inline-error button, .fr-word-fallback-note button { border: 1px solid currentColor; border-radius: 6px; padding: 2px 7px; background: transparent; color: inherit; cursor: pointer; font-size: 11px; }
.fr-inline-error { flex-wrap: wrap; }
.fr-inline-error .fr-error-actions { margin-left: auto; justify-content: flex-end; }
.fr-word-fallback-note button { flex-shrink: 0; white-space: nowrap; }
.fr-text-block { display:flow-root; padding: 0; }
.fr-text-block + .fr-text-block { padding-top: 9px; border-top: 1px solid rgba(127, 127, 140, .12); }
.fr-original-text { color: #666570; }
.fr-inline-code { padding: 1px 4px; border-radius: 4px; background: rgba(127, 127, 127, .14); color: inherit; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: .92em; white-space: pre-wrap; }
.fr-translation-result { color: #39373d; }
.fr-text-block-header { float:inline-end; margin-inline-start:8px; }
.fr-text-label { margin: 0; color: #9797a4; font-size: 11px; font-weight: 750; letter-spacing: .01em; }
.fr-text-actions { display: flex; flex: none; align-items: center; gap: 1px; }
.fr-text-copy-btn { display: inline-flex; align-items: center; justify-content: center; width:26px; height:26px; padding:0; border:1px solid transparent; border-radius:5px; background:transparent; color:#85858e; cursor:pointer; font:inherit; line-height:1; }
.fr-text-copy-btn span, .fr-text-block-header > .fr-text-label, .fr-word-translation-header > .fr-text-label { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
.fr-text-copy-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }
.fr-text-copy-btn:hover, .fr-text-copy-btn:focus-visible { border-color: rgba(214, 63, 118, .35); background: #fff; color: #d63f76; outline: none; transform: translateY(-1px); }
.fr-text-copy-btn.fr-copied { border-color: rgba(214, 63, 118, .2); background: rgba(255, 255, 255, .72); color: #b85c7b; }
.fr-text-copy-btn:disabled { cursor: not-allowed; opacity: .42; transform: none; }
.fr-text-audio-btn { position: static; display: grid; flex: none; width:26px; height:26px; padding:0; place-items:center; border:1px solid transparent; border-radius:5px; background:transparent; color:#85858e; }
.fr-text-audio-btn svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.fr-text-audio-btn:hover, .fr-text-audio-btn:focus-visible { border-color: rgba(214, 63, 118, .25); background: rgba(255, 255, 255, .72); color: #d63f76; outline: none; transform: translateY(-1px); }
.fr-text-block pre { overflow-wrap:anywhere; margin:0; white-space:pre-wrap; word-break:break-word; font:inherit; font-size:14px; line-height:1.7; user-select:text; }
.fr-original-text pre { font-size:12.5px; line-height:1.65; }
.fr-playing-status { flex: none; box-sizing: border-box; min-height: 38px; padding: 5px 14px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap:6px 8px; border-top: 1px solid #eeedf0; background: inherit; color: #777780; font-size: 12px; line-height: 1.4; }
.fr-playing-status.is-idle { display: none; }
.fr-playing-status button { flex: none; min-height: 27px; border: 1px solid #e8a4bc; border-radius: 7px; padding: 3px 8px; color: #d83e70; font: inherit; line-height: 1.2; }
.fr-playing-label { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fr-playback-controls { display:flex; flex-wrap:wrap; flex:0 1 auto; max-width:100%; margin-inline-start:auto; align-items:center; justify-content:flex-end; gap:5px; }
.fr-playback-time { font-size:10px; font-variant-numeric:tabular-nums; white-space:nowrap; }
.fr-playing-status .fr-seek-btn { display:grid; place-items:center; width:27px; height:27px; padding:0; border-color:transparent; color:inherit; }
.fr-seek-btn svg { width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
.fr-seek-btn text { fill:currentColor; stroke:none; font:10px system-ui; text-anchor:middle; }
.fr-playing-status .fr-seek-btn:hover:not(:disabled) { background:color-mix(in srgb,currentColor 10%,transparent); }
.fr-playing-status button:focus-visible { outline:2px solid currentColor; outline-offset:2px; }
.fr-playing-status .fr-seek-btn:disabled { opacity:.35; cursor:default; }
.fr-copy-success-toast { position: fixed; right: 18px; bottom: 18px; padding: 9px 13px; border-radius: 9px; background: #2c2c35; color: #fff; font-size: 12px; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
.fr-action-toast { position: fixed; right: 18px; bottom: 18px; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: max-content; overflow: auto; padding: 9px 13px; border-radius: 9px; background: #2c2c35; color: #fff; font-size: 12px; box-shadow: 0 6px 18px rgba(0, 0, 0, .18); }
.fr-action-toast > span { min-width: 0; max-height: var(--fr-notice-content-height); overflow: auto; overflow-wrap: anywhere; }
.fr-action-toast button { flex: none; padding: 0; border: 0; color: #ffc2d5; background: transparent; cursor: pointer; font: inherit; font-weight: 700; }
.fr-action-toast button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
.fr-dark-theme { border-color: #44444e; background: rgba(40, 40, 48, .98); color: #f1f1f4; }
.fr-reading-tooltip.fr-dark-theme { background: #282830; }
.fr-dark-theme .fr-action-btn:hover, .fr-dark-theme .fr-close-btn:hover { background: #50505b; color: #fff; }
.fr-dark-theme :is(.fr-text-copy-btn, .fr-text-audio-btn) { border-color:transparent; background:transparent; color:#b4aab3; }
.fr-dark-theme :is(.fr-text-copy-btn, .fr-text-audio-btn):is(:hover, :focus-visible) { border-color: #c96a8b; background: #553846; color: #ffd9e7; }
.fr-dark-theme .fr-text-copy-btn.fr-copied { border-color: #98617a; background: rgba(93, 52, 71, .62); color: #f2bdcd; }
.fr-dark-theme .fr-playing-status { border-color:#4d404a; color:#c8bdc6; }
.fr-dark-theme .fr-original-text { color: #d0d0d7; }
.fr-dark-theme .fr-translation-result { color: #f1ecef; }
.fr-dark-theme .fr-word-learning-card { background: transparent; }
.fr-dark-theme :is(.fr-word-heading, .fr-word-pronunciations, .fr-word-translation, .fr-word-card-footer) { border-color: #4b4148; }
.fr-dark-theme .fr-word-heading h3, .fr-dark-theme .fr-word-meaning, .fr-dark-theme .fr-word-translation { color: #f2e8ed; }
.fr-dark-theme .fr-word-meaning-toolbar { color: #c8aab5; }
.fr-dark-theme .fr-word-meaning-toolbar button { color: #f0b9cb; }
.fr-dark-theme .fr-word-heading-audio { background: #4a454b; color: #d5c4cb; }
.fr-dark-theme .fr-word-pronunciation { border-color: #443a42; }
.fr-dark-theme .fr-word-pronunciation-label { color: #e0a7b9; }
.fr-dark-theme .fr-word-ipa { color: #f0dce4; }
.fr-dark-theme .fr-word-meaning > strong { border-color: #684b58; background: #493842; color: #ffd9e7; }
.fr-dark-theme .fr-word-meaning em { border-color: #684b58; }
.fr-dark-theme .fr-word-meaning em, .fr-dark-theme :is(.fr-word-definition-zh, .fr-word-example-zh, .fr-word-translation-loading, .fr-word-empty) { color: #c8aab5; }
.fr-dark-theme .fr-word-fallback-note { background: #4a303b; }
/* 保持桌面紧凑；触摸操作用完整命中区，点模式仍只显示小点，不挤占正文。 */
.fr-touch-selection .fr-selection-indicator { width:44px; height:44px; border-radius:12px; touch-action:manipulation; }
.fr-touch-selection .fr-selection-indicator--dot { background:transparent; box-shadow:none; }
.fr-touch-selection .fr-selection-indicator--dot::after { content:''; position:absolute; inset:18px; border-radius:50%; background:#ef4b86; }
.fr-touch-selection .fr-translation-tooltip button, .fr-touch-selection .fr-action-toast button { min-width:44px; min-height:44px; touch-action:manipulation; }
.fr-touch-selection .fr-study-navigation { touch-action:none; }
.fr-touch-selection .fr-study-toolbar { touch-action:pan-x; }
.fr-touch-selection .fr-popup-resize-handle { display:none; }
.fr-touch-selection .fr-playing-status { height:auto; min-height:52px; flex-wrap:wrap; }
.fr-touch-selection .fr-tooltip-content { -webkit-overflow-scrolling:touch; }
.fr-touch-selection .fr-copy-success-toast { right:max(12px, env(safe-area-inset-right)); bottom:max(12px, env(safe-area-inset-bottom)); }
@media (any-pointer: coarse) {
  .fr-translation-tooltip button, .fr-action-toast button { min-width:44px; min-height:44px; touch-action:manipulation; }
  .fr-playing-status { height:auto; min-height:52px; flex-wrap:wrap; }
}
/* 极矮时标题、正文和语音栏共用外框滚动；不替换或隐藏已聚焦的阅读输入。 */
.fr-translation-tooltip.fr-short-viewport { overflow-y:auto; border-block-width:0; overscroll-behavior:contain; }
.fr-short-viewport .fr-study-navigation { align-items:flex-start; padding-block:var(--fr-pad); border-bottom:0; touch-action:auto; }
.fr-short-viewport .fr-study-toolbar { touch-action:auto; overscroll-behavior-y:auto; }
.fr-short-viewport .fr-close-btn { min-width:44px; min-height:44px; }
.fr-short-viewport .fr-tooltip-content, .fr-short-viewport :deep(.fr-reading), .fr-short-viewport :deep(.fr-reading-scroll) { flex:none; height:auto; max-height:none; overflow:visible; }
.fr-short-viewport .fr-popup-resize-handle { display:none; }
@media (prefers-reduced-motion: reduce) { .fr-selection-indicator, .fr-loading-spinner { transition: none; animation: none; } }

</style>
