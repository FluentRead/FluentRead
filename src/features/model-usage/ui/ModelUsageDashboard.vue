<!--
 @file src/features/model-usage/ui/ModelUsageDashboard.vue
 文件职责：在 Options 设置页展示当前浏览器保存的模型调用可观测数据，并提供筛选、请求明细和清除统计入口。
 主要内容：按界面语言格式化 Token、日期和耗时，呈现请求概览，支持双指标趋势及键盘选取、互斥 Token 构成、模型排行筛选和按需展开的稳定游标请求记录。
 模块边界：组件只消费后台白名单数据，不读取 API Key、不记录原文、译文、提示词或网址，也不直接访问 IndexedDB；事件采集、Token 解释、持久化及备份恢复由 services、providers、background 与统一“备份与恢复”页面拥有。
-->
<template>
  <section id="settings-model-usage" class="model-usage-dashboard" aria-label="模型用量统计">
    <div class="usage-toolbar">
      <div class="usage-filter-grid" aria-label="模型用量筛选">
        <label class="usage-filter">
          <span>服务</span>
          <div class="usage-select-shell">
            <ServiceIcon
              v-if="selectedService"
              :service="selectedService"
              :label="serviceLabel(selectedService)"
              size="small"
            />
            <el-select v-model="selectedService" class="usage-select" popper-class="usage-select-popper" fit-input-width aria-label="模型用量服务" placeholder="全部 AI 服务" @change="handleServiceChange">
              <el-option label="全部 AI 服务" value="" />
              <el-option v-for="service in serviceOptions" :key="service.id" :label="service.label" :value="service.id" />
            </el-select>
          </div>
        </label>

        <label class="usage-filter">
          <span>模型</span>
          <div class="usage-select-shell">
            <el-select v-model="selectedModel" class="usage-select" popper-class="usage-select-popper" fit-input-width aria-label="模型用量模型" placeholder="全部模型">
              <el-option label="全部模型" value="" />
              <el-option v-for="model in modelOptions" :key="model" :label="modelLabel(model)" :value="model" />
            </el-select>
          </div>
        </label>

        <div class="usage-range-filter">
          <span>时间范围</span>
          <div ref="rangeControl" class="usage-range-control" role="radiogroup" aria-label="模型用量时间范围">
            <button
              v-for="(option, index) in rangeOptions"
              :key="option.value"
              type="button"
              role="radio"
              :data-range-index="index"
              :aria-checked="range === option.value"
              :tabindex="range === option.value ? 0 : -1"
              :class="{ active: range === option.value }"
              @click="range = option.value"
              @keydown="handleRangeKeydown($event, index)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>
      </div>

      <div class="usage-toolbar-actions">
        <button type="button" class="usage-refresh-button" :disabled="loading" @click="loadSnapshot">{{ loading ? '更新中…' : '刷新' }}</button>
        <button ref="resetButton" type="button" class="usage-reset-button" @click="openResetDialog">
          清除统计
        </button>
      </div>
    </div>

    <div class="usage-local-notice">
      <span aria-hidden="true">本机</span>
      <p>仅统计当前浏览器保留的最近 1,000 次模型调用</p>
      <small v-if="snapshot">{{ generatedAtLabel }}</small>
      <details class="usage-data-help">
        <summary>统计说明</summary>
        <p>统计保存在当前浏览器，最多保留最近 1,000 条调用记录，超出后删除更早记录；不等同于服务商账号的全部历史用量或剩余额度。完整备份与恢复统一在“备份与恢复”中管理。</p>
        <p><span>{{ recordingStartLabel }}</span>。<span>Token 来自服务商实际返回；未上报的用量不作估算。缓存读取已包含在输入内，推理明细不另加到总量。</span></p>
      </details>
    </div>

    <div v-if="hasActiveFilter && snapshot" class="usage-active-filter"><span>{{ appliedScopeLabel }} · {{ appliedRangeLabel }}</span><button type="button" @click="clearFilters">重置筛选</button></div>

    <div v-if="resetMessage" class="usage-reset-message" role="status">
      {{ resetMessage }}
    </div>

    <div v-if="errorMessage && snapshot" class="usage-inline-error" role="status">
      <span>{{ errorMessage }}</span>
      <button type="button" @click="loadSnapshot">重试</button>
    </div>

    <div v-if="loading && !snapshot" class="usage-state-card" aria-live="polite">
      <span class="usage-loader" aria-hidden="true"></span>
      <strong>正在读取本机统计</strong>
      <p>不会向模型服务商额外发送请求。</p>
    </div>

    <div v-else-if="errorMessage && !snapshot" class="usage-state-card usage-error-state" role="alert">
      <span aria-hidden="true">!</span>
      <strong>暂时无法读取模型用量</strong>
      <p>{{ errorMessage }}</p>
      <button type="button" @click="loadSnapshot">重新读取</button>
    </div>

    <template v-else-if="snapshot">
      <div class="usage-summary-grid" :aria-busy="loading">
        <article class="usage-card usage-token-card">
          <div class="usage-card-heading">
            <div class="usage-summary-copy">
              <span>Token 使用量</span>
              <strong
                :title="selectedTotals.reportedTokenRequests ? tokenExactTitle(selectedTotals.totalTokens) : '暂无已上报的 Token'"
                :aria-label="selectedTotals.reportedTokenRequests ? tokenAriaLabel(selectedTotals.totalTokens) : '暂无已上报的 Token'"
              >{{ tokenValue(selectedTotals, 'totalTokens') }}</strong>
              <small class="usage-card-context">
                {{ appliedRangeLabel }} · {{ appliedScopeLabel }}
                <em v-if="loading">正在更新…</em>
              </small>
            </div>
            <span class="usage-card-badge">本机统计</span>
          </div>
          <div class="usage-total-parts">
            <span>输入 <b>{{ tokenValue(selectedTotals, 'inputTokens') }}</b></span>
            <span>输出 <b>{{ tokenValue(selectedTotals, 'outputTokens') }}</b></span>
          </div>
        </article>

        <article class="usage-card usage-compact-card">
          <div class="usage-metric-heading">
            <span>模型请求</span>
            <small>{{ appliedRangeLabel }}</small>
          </div>
          <strong>{{ formatNumber(selectedTotals.requestCount) }}</strong>
          <div class="usage-success-meter"><span :style="{ width: `${(health.successRate || 0) * 100}%` }"></span></div>
          <small>
            {{ formatNumber(selectedTotals.successfulRequests) }} <span>成功</span> <span aria-hidden="true">·</span>
            {{ formatNumber(selectedTotals.errorRequests) }} <span>错误</span> <span aria-hidden="true">·</span>
            {{ formatNumber(selectedTotals.timeoutRequests) }} <span>超时</span> <span aria-hidden="true">·</span>
            {{ formatNumber(selectedTotals.cancelledRequests) }} <span>取消</span>
          </small>
        </article>

        <article class="usage-card usage-compact-card usage-duration-card">
          <div class="usage-metric-heading"><span>平均耗时</span><small>全部调用</small></div>
          <strong>{{ selectedTotals.averageDurationMs === null ? '—' : formatDuration(selectedTotals.averageDurationMs) }}</strong>
          <small>包括成功、失败与取消</small>
        </article>
        <article class="usage-card usage-compact-card usage-cache-card">
          <div class="usage-metric-heading"><span>缓存读取比率</span><small>可计算输入</small></div>
          <strong>{{ formatUsageRate(selectedTotals.cacheTokenHitRate) }}</strong>
          <small v-if="selectedTotals.cacheReportedRequests"><span>{{ formatToken(selectedTotals.cachedInputTokens) }} Token</span> · <span>仅统计已上报缓存明细的调用</span></small>
          <small v-else>服务商未上报缓存明细</small>
        </article>
      </div>

      <div v-if="hasIncompleteCoverage" class="usage-coverage-note" role="status">
        <strong><span>Token 上报率</span> {{ coverageLabel }}</strong>
        <span>{{ health.unreportedRequests }} <span>次调用未提供 Token；总量仅包含已上报部分。</span></span>
      </div>

      <div v-if="!hasSelectedUsage" class="usage-state-card usage-empty-state">
        <span aria-hidden="true">∿</span>
        <strong>{{ hasActiveFilter ? '当前筛选还没有调用记录' : '还没有模型调用记录' }}</strong>
        <p>
          {{ hasActiveFilter ? '可以切回全部服务、全部模型或更长的时间范围。' : '从下一次使用 AI 翻译开始，这里会在本机记录请求和 Token。' }}
        </p>
        <button v-if="hasActiveFilter" type="button" @click="clearFilters">查看全部用量</button>
      </div>

      <div v-else class="usage-detail-grid">
        <figure class="usage-card usage-trend-card" :aria-label="trendAriaLabel">
          <figcaption>
            <div><span>{{ appliedRangeLabel }} · {{ appliedScopeLabel }}</span><strong>用量趋势</strong></div>
            <div class="usage-metric-toggle" role="group" aria-label="趋势指标">
              <button type="button" :aria-pressed="trendMetric === 'tokens'" @click="trendMetric = 'tokens'">Token</button>
              <button type="button" :aria-pressed="trendMetric === 'requests'" @click="trendMetric = 'requests'">请求次数</button>
            </div>
          </figcaption>
          <div class="usage-chart-scale"><span>{{ formatToken(timeline.maximum) }} {{ trendMetric === 'tokens' ? 'Token' : '次' }}</span><span>{{ appliedFilter.range === 'today' ? '按小时' : '按天' }}</span></div>
          <ol v-if="timelineRows.length" class="usage-trend-plot" aria-label="按时间排列的用量数据"
              :style="{ gridTemplateColumns: `repeat(${timelineRows.length}, minmax(0, 1fr))` }">
            <li v-for="(point, index) in timelineRows" :key="point.key">
              <button type="button" class="usage-trend-point" :class="{ selected: inspectedPoint?.key === point.key, unreported: point.unreportedRequests > 0 }"
                :aria-label="timelinePointLabel(point)" :aria-pressed="inspectedPoint?.key === point.key"
                @click="selectedPointKey = point.key" @focus="selectedPointKey = point.key" @keydown="handleTrendKeydown($event, index)">
                <span class="usage-bar-track" aria-hidden="true">
                  <span class="usage-bar" :style="{ height: `${point.height}%` }">
                    <span v-for="segment in point.segments" :key="segment.key" :class="`usage-segment-${segment.key}`" :style="{ height: `${segment.share * 100}%` }"></span>
                  </span>
                </span>
              </button>
              <span :class="{ muted: !showTimelineLabel(index) }">{{ showTimelineLabel(index) ? point.label : '·' }}</span>
            </li>
          </ol>
          <div v-else class="usage-chart-empty">当前范围没有可绘制的数据</div>
          <div class="usage-chart-baseline">0</div>
          <div v-if="inspectedPoint" class="usage-trend-inspector" aria-live="polite" aria-atomic="true">
            <strong>{{ inspectedPoint.label }}</strong>
            <span><b>{{ exactTokenValue(inspectedPoint.totals, 'totalTokens') }}</b> Token</span>
            <span><b>{{ formatNumber(inspectedPoint.totals.requestCount) }}</b> <span>次请求</span></span>
            <span v-if="inspectedPoint.unreportedRequests" class="usage-missing-label">{{ inspectedPoint.unreportedRequests }} <span>次未上报</span></span>
            <small v-if="trendMetric === 'tokens' && inspectedPoint.differenceTokens !== 0"><span>组成合计</span> {{ formatNumber(inspectedPoint.value) }} Token · <span>上报总计与组成不一致</span></small>
            <small v-if="trendMetric === 'tokens'"><span>输入</span> {{ exactTokenValue(inspectedPoint.totals, 'inputTokens') }} · <span>输出</span> {{ exactTokenValue(inspectedPoint.totals, 'outputTokens') }}</small>
            <small v-else><span v-for="(item, index) in inspectedPoint.segments" :key="item.key">{{ index ? ' · ' : '' }}<span>{{ item.label }}</span> {{ item.value }}</span></small>
          </div>
          <div v-if="trendMetric === 'tokens'" class="usage-legend usage-token-legend"><span v-for="segment in timelineLegend" :key="segment.key"><i :class="`usage-segment-${segment.key}`"></i>{{ segment.label }}</span></div>
          <div v-if="trendMetric === 'requests'" class="usage-legend usage-request-legend"><span v-for="item in outcomeLegend" :key="item.key"><i :class="`usage-segment-${item.key}`"></i>{{ item.label }}</span></div>
          <p class="usage-chart-hint">点击柱形查看明细 · 方向键切换时间<span v-if="timelineHasDifference"> · 上报总计与组成不一致，柱高按组成绘制</span></p>
        </figure>

        <section class="usage-card usage-composition-card" aria-labelledby="usage-composition-title">
          <header><span>这些 Token 用在哪里</span><strong id="usage-composition-title">用量构成</strong></header>
          <div v-if="composition.compositionTokens" class="usage-composition-strip" aria-hidden="true">
            <span v-for="segment in visibleComposition" :key="segment.key" :class="`usage-segment-${segment.key}`" :style="{ width: `${segment.share * 100}%` }"></span>
          </div>
          <p v-else class="usage-composition-empty">{{ composition.hasReportedTokens ? '已上报用量为 0 Token' : '服务商尚未提供 Token 明细' }}</p>
          <dl class="usage-composition-list">
            <div v-for="segment in visibleComposition" :key="segment.key" class="usage-composition-row" :data-segment="segment.key">
              <dt><i :class="`usage-segment-${segment.key}`"></i>{{ segment.label }}</dt>
              <dd><strong class="usage-composition-value" :title="tokenExactTitle(segment.tokens)">{{ formatToken(segment.tokens) }}</strong><small>{{ formatUsageRate(segment.share) }}</small></dd>
            </div>
          </dl>
          <p class="usage-composition-note">缓存读取属于输入，已单独拆出。<span v-if="composition.differenceTokens < 0">上报总计小于组成合计，占比按组成计算。</span></p>
        <details class="usage-average-card">
          <summary>查看每次请求的平均构成</summary>
          <div class="usage-metric-heading">
            <span>平均每次请求</span>
            <small>Token 构成</small>
          </div>
          <div class="usage-average-grid">
            <div class="usage-average-value">
              <span>输入（无缓存）</span>
              <strong :title="averageTokenTitle(selectedTotals.averageUncachedInputTokensPerCacheReportedRequest)">{{ formatAverageValue(selectedTotals.averageUncachedInputTokensPerCacheReportedRequest) }}</strong>
              <small>平均 Token</small>
              <em><span>占比</span> {{ formatUsageRate(selectedTotals.uncachedInputTokenShare) }}</em>
            </div>
            <div class="usage-average-value usage-average-cache">
              <span>缓存读取</span>
              <strong :title="averageTokenTitle(selectedTotals.averageCachedInputTokensPerCacheReportedRequest)">{{ formatAverageValue(selectedTotals.averageCachedInputTokensPerCacheReportedRequest) }}</strong>
              <small>平均 Token</small>
              <em><span>占比</span> {{ formatUsageRate(selectedTotals.cachedInputTokenShare) }}</em>
            </div>
            <div class="usage-average-value">
              <span>输出</span>
              <strong :title="averageTokenTitle(selectedTotals.averageOutputTokensPerCacheReportedRequest)">{{ formatAverageValue(selectedTotals.averageOutputTokensPerCacheReportedRequest) }}</strong>
              <small>平均 Token</small>
              <em><span>占比</span> {{ formatUsageRate(selectedTotals.outputTokenShare) }}</em>
            </div>
          </div>
          <div v-if="selectedTotals.cacheReportedRequests" class="usage-average-footnote">
            <strong>
              {{ selectedTotals.cacheHitRequests }}/{{ selectedTotals.cacheReportedRequests }}
              次{{ selectedTotals.cacheReportedRequests < selectedTotals.reportedTokenRequests ? '可计算' : '' }}请求命中
            </strong>
            <span>平均值与占比按可计算请求统计</span>
          </div>
          <div v-else class="usage-average-footnote">
            <strong>缓存读取未上报</strong>
            <span>暂时无法拆分输入与缓存构成</span>
          </div>
        </details>
        </section>

        <section class="usage-card usage-breakdown-card" aria-labelledby="usage-breakdown-title">
          <header>
            <div>
              <span>服务与模型分布</span>
              <strong id="usage-breakdown-title">谁产生了这些 Token</strong>
            </div>
            <small>点击一行筛选</small>
          </header>

          <div class="usage-breakdown-heading" aria-label="分布排序">
            <span>服务 / 模型</span>
            <button
              v-for="option in breakdownSortOptions"
              :key="option.key"
              type="button"
              :data-sort-key="option.key"
              :aria-label="`按${option.label}排序`"
              :aria-pressed="breakdownSort === option.key"
              :class="{ active: breakdownSort === option.key }"
              @click="breakdownSort = option.key"
            >
              {{ option.label }}
            </button>
          </div>
          <div class="usage-breakdown-list">
            <button
              v-for="row in visibleBreakdown"
              :key="`${row.serviceId}:${row.model}`"
              type="button"
              :class="{ active: appliedFilter.serviceId === row.serviceId && appliedFilter.model === row.model }"
              :aria-label="`${serviceLabel(row.serviceId)} ${modelLabel(row.model)}，输入 ${exactTokenValue(row.totals, 'inputTokens')} Token，其中缓存读取 ${row.totals.cacheReportedRequests ? formatNumber(row.totals.cachedInputTokens) : '未上报'} Token，缓存 Token 命中率 ${formatUsageRate(row.totals.cacheTokenHitRate)}，输出 ${exactTokenValue(row.totals, 'outputTokens')} Token，共 ${exactTokenValue(row.totals, 'totalTokens')} Token，${formatNumber(row.totals.requestCount)} 次请求，点击筛选`"
              @click="selectBreakdown(row.serviceId, row.model)"
            >
              <ServiceIcon :service="row.serviceId" :label="serviceLabel(row.serviceId)" size="small" />
              <span class="usage-breakdown-copy">
                <strong>{{ serviceLabel(row.serviceId) }}</strong>
                <small>{{ modelLabel(row.model) }}</small>
                <i aria-hidden="true"><b :style="{ width: `${breakdownShare(row.totals.totalTokens)}%` }"></b></i>
              </span>
              <strong class="usage-breakdown-value" :title="row.totals.reportedTokenRequests ? tokenExactTitle(row.totals.inputTokens) : '服务商未返回 Token 明细'">{{ tokenValue(row.totals, 'inputTokens') }}</strong>
              <strong class="usage-breakdown-value usage-breakdown-cache" :title="cacheBreakdownTitle(row.totals)">{{ row.totals.cacheReportedRequests ? formatToken(row.totals.cachedInputTokens) : '—' }}</strong>
              <strong class="usage-breakdown-value" :title="row.totals.reportedTokenRequests ? tokenExactTitle(row.totals.outputTokens) : '服务商未返回 Token 明细'">{{ tokenValue(row.totals, 'outputTokens') }}</strong>
              <strong class="usage-breakdown-value usage-breakdown-requests">{{ formatNumber(row.totals.requestCount) }}</strong>
              <strong class="usage-breakdown-value usage-breakdown-total" :title="row.totals.reportedTokenRequests ? tokenExactTitle(row.totals.totalTokens) : '服务商未返回 Token 明细'">{{ tokenValue(row.totals, 'totalTokens') }}</strong>
            </button>
          </div>
          <button
            v-if="snapshot.breakdown.length > BREAKDOWN_PREVIEW_COUNT"
            type="button"
            class="usage-show-all"
            :aria-expanded="showAllBreakdown"
            @click="showAllBreakdown = !showAllBreakdown"
          >
            {{ showAllBreakdown ? '收起' : `查看全部 ${snapshot.breakdown.length} 项` }}
          </button>
        </section>
      </div>

      <details v-if="hasSelectedUsage" class="usage-card usage-request-log-card" :aria-busy="loading || requestLogLoading" @toggle="handleRequestLogToggle">
        <summary class="usage-request-summary"><span><strong>请求记录</strong><small>查看每一次调用的用量与状态</small></span><span>{{ formatNumber(selectedTotals.requestCount) }} <span>次调用</span> <i aria-hidden="true">⌄</i></span></summary>
        <header class="usage-request-log-header">
          <div>
            <span>请求明细</span>
            <strong id="usage-request-log-title">模型调用记录</strong>
            <small>第 {{ requestPageStart }}–{{ requestPageEnd }} 条，共 {{ formatNumber(requestLogTotalCount) }} 条</small>
          </div>
          <div class="usage-request-filters" aria-label="请求记录筛选">
            <label>
              <span>场景</span>
              <UiSelect :disabled="loading || requestLogLoading" v-model="requestPurpose" aria-label="按调用场景筛选请求记录">
                <ElOption value="" :label="translateLegacy('全部场景')" />
                <ElOption value="translation" :label="translateLegacy('翻译')" />
                <ElOption value="page-summary" :label="translateLegacy('页面摘要')" />
                <ElOption value="connection-test" :label="translateLegacy('连接测试')" />
                <ElOption value="writing" label="写作助手" />
                <ElOption value="reading" :label="translateLegacy('阅读理解')" />
              </UiSelect>
            </label>
            <label>
              <span>状态</span>
              <UiSelect :disabled="loading || requestLogLoading" v-model="requestOutcome" aria-label="按调用状态筛选请求记录">
                <ElOption value="" :label="translateLegacy('全部状态')" />
                <ElOption value="success" :label="translateLegacy('成功')" />
                <ElOption value="error" :label="translateLegacy('错误')" />
                <ElOption value="timeout" :label="translateLegacy('超时')" />
                <ElOption value="cancelled" :label="translateLegacy('已取消')" />
              </UiSelect>
            </label>
            <label>
              <span>缓存</span>
              <UiSelect :disabled="loading || requestLogLoading" v-model="requestCacheStatus" aria-label="按模型缓存状态筛选请求记录">
                <ElOption value="" :label="translateLegacy('全部缓存状态')" />
                <ElOption value="hit" :label="translateLegacy('已命中')" />
                <ElOption value="miss" :label="translateLegacy('未命中')" />
                <ElOption value="unreported" :label="translateLegacy('未上报')" />
              </UiSelect>
            </label>
          </div>
        </header>

        <p class="usage-request-privacy">
          仅记录时间、服务与模型、调用场景、状态、耗时及服务商返回的 Token；不保存原文、译文、提示词、网页地址、API Key、请求体或响应正文。
        </p>

        <div v-if="requestLogError" class="usage-request-log-error" role="alert">
          <span>{{ requestLogError }}</span>
          <button type="button" :disabled="loading || requestLogLoading" @click="loadRequestPage(requestLogRetryPageIndex)">重试</button>
        </div>
        <div v-if="requestLogLoading && !requestLogItems.length" class="usage-request-log-loading" role="status">
          正在读取请求记录…
        </div>
        <div v-else-if="!requestLogItems.length && !requestLogError" class="usage-request-log-empty">
          当前记录筛选下没有请求。
        </div>
        <div v-else class="usage-request-table-wrap">
          <table class="usage-request-table">
            <caption>当前服务、模型、时间范围与记录筛选下的大模型上游请求</caption>
            <thead>
              <tr>
                <th scope="col">发起时间</th>
                <th scope="col">服务 / 模型</th>
                <th scope="col">场景</th>
                <th scope="col">状态</th>
                <th scope="col">耗时</th>
                <th scope="col">Token 明细</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in requestLogItems" :key="item.id">
                <td data-label="发起时间">
                  <time :datetime="new Date(item.startedAt).toISOString()">{{ formatRequestTime(item.startedAt) }}</time>
                </td>
                <td data-label="服务 / 模型">
                  <span class="usage-request-service">
                    <ServiceIcon :service="item.serviceId" :label="serviceLabel(item.serviceId)" size="small" />
                    <span>
                      <strong>{{ serviceLabel(item.serviceId) }}</strong>
                      <small>{{ modelLabel(item.model) }}</small>
                      <small v-if="item.actualModel && item.actualModel !== item.configuredModel">配置模型：{{ modelLabel(item.configuredModel) }}</small>
                    </span>
                  </span>
                </td>
                <td data-label="场景"><span class="usage-purpose">{{ purposeLabel(item.purpose) }}</span></td>
                <td data-label="状态">
                  <span class="usage-request-status">
                    <strong :class="`is-${item.outcome}`">{{ outcomeLabel(item.outcome) }}</strong>
                    <small v-if="item.statusCode">HTTP {{ item.statusCode }}</small>
                  </span>
                </td>
                <td data-label="耗时">{{ formatDuration(item.durationMs) }}</td>
                <td data-label="Token 明细" class="usage-request-token-cell">
                  <template v-if="item.usageAvailability === 'reported'">
                    <div class="usage-request-tokens">
                      <span><i>输入</i><b :title="tokenExactTitle(item.inputTokens || 0)">{{ formatToken(item.inputTokens || 0) }}</b></span>
                      <span :class="{ hit: isCacheHit(item), miss: item.cachedInputTokens === 0 }">
                        <i>缓存读取</i>
                        <b :title="requestCacheTitle(item)">{{ requestCacheTokenValue(item) }}</b>
                        <small>{{ requestCacheRateLabel(item) }}</small>
                      </span>
                      <span><i>输出</i><b :title="tokenExactTitle(item.outputTokens || 0)">{{ formatToken(item.outputTokens || 0) }}</b></span>
                      <span><i>总计</i><b :title="tokenExactTitle(item.totalTokens || 0)">{{ formatToken(item.totalTokens || 0) }}</b></span>
                    </div>
                    <small v-if="item.cacheWriteTokens || item.reasoningTokens" class="usage-request-token-extra">
                      <span v-if="item.cacheWriteTokens">缓存创建（服务商上报）{{ formatToken(item.cacheWriteTokens) }} Token</span>
                      <span v-if="item.reasoningTokens">推理 {{ formatToken(item.reasoningTokens) }}</span>
                    </small>
                  </template>
                  <span v-else class="usage-unreported-token">{{ usageAvailabilityLabel(item.usageAvailability) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <footer v-if="requestLogTotalCount" class="usage-request-log-footer" aria-live="polite">
          <label class="usage-page-size">
            <span>每页</span>
            <UiSelect :disabled="loading || requestLogLoading" v-model="requestPageSize" aria-label="每页请求记录数量">
              <ElOption v-for="size in requestPageSizeOptions" :key="size" :value="size" :label="t('usage.pageSize', {size})" />
            </UiSelect>
          </label>
          <nav class="usage-request-pagination" aria-label="请求记录分页">
            <button type="button" :disabled="loading || requestLogLoading || requestPageIndex === 0" @click="loadRequestPage(requestPageIndex - 1)">上一页</button>
            <span>第 {{ requestPageIndex + 1 }} / {{ requestPageCount }} 页</span>
            <button type="button" :disabled="loading || requestLogLoading || !requestLogNextCursor" @click="loadNextRequestPage">下一页</button>
          </nav>
        </footer>
      </details>
    </template>

    <Teleport to="body">
      <div v-if="resetDialogOpen" class="usage-dialog-backdrop" @click.self="closeResetDialog">
        <section
          ref="resetDialog"
          class="usage-reset-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="usage-reset-title"
          aria-describedby="usage-reset-description"
          tabindex="-1"
          @keydown="handleResetDialogKeydown"
        >
          <span class="usage-dialog-icon" aria-hidden="true">!</span>
          <h2 id="usage-reset-title">清除本机模型用量？</h2>
          <p id="usage-reset-description">会删除本机请求记录及其汇总；不会删除 API Key、翻译设置、FluentRead 译文缓存或配置历史。此操作无法撤销。</p>
          <p v-if="resetError" class="usage-dialog-error" role="alert">{{ resetError }}</p>
          <div>
            <button ref="resetCancelButton" type="button" :disabled="resetting" @click="closeResetDialog">取消</button>
            <button type="button" class="danger" :disabled="resetting" @click="resetUsage">
              {{ resetting ? '正在清除…' : '确认清除统计' }}
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import UiSelect from '@/src/ui/components/UiSelect.vue';
import {ElOption} from 'element-plus';

import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import browser from 'webextension-polyfill'
import {options} from '@/src/core/config/catalog'
import {
  getCustomOpenAIProviderLabel,
  type CustomOpenAIProvider,
} from '@/src/core/config/customOpenAI'
import {config, subscribeConfig} from '@/src/services/config/store'
import {buildUsageComposition, buildUsageHealth, buildUsageTimeline, type UsageTimelineMetric} from '@/src/features/model-usage/model/insights'
import {formatTokenCount, formatUsageRate as formatRate} from '@/src/features/model-usage/model/tokenFormat'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import {useUiI18n} from '@/src/ui/i18n'
import {
  MODEL_USAGE_REQUEST_MAX_PAGE_SIZE,
  MODEL_USAGE_REQUEST_PAGE_SIZE,
  type DashboardSnapshot,
  type Filter,
  type ModelUsageCacheStatus,
  type ModelUsageOutcome,
  type ModelUsagePurpose,
  type ModelUsageRequestCursor,
  type ModelUsageRequestPage,
  type Range,
  type StoredModelUsageEvent,
  type Totals,
} from '@/src/services/model-usage/types'

type ModelUsageResponse<T> = {
  success?: boolean
  data?: T
  error?: string
}

type BreakdownSortKey = 'input' | 'cache' | 'output' | 'requests' | 'total'
type RequestPurposeFilter = '' | ModelUsagePurpose
type RequestOutcomeFilter = '' | ModelUsageOutcome
type RequestCacheFilter = '' | ModelUsageCacheStatus

const BREAKDOWN_PREVIEW_COUNT = 8
const requestPageSizeOptions = [20, 50, MODEL_USAGE_REQUEST_MAX_PAGE_SIZE] as const
const numberFormatter = computed(() => new Intl.NumberFormat(language.value, {maximumFractionDigits: 0}))
const requestDateFormatter = computed(() => new Intl.DateTimeFormat(language.value, {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}))
const rangeOptions: Array<{value: Range; label: string}> = [
  {value: 'today', label: '今日'},
  {value: '7d', label: '7 天'},
  {value: '30d', label: '30 天'},
]
const breakdownSortOptions: Array<{key: BreakdownSortKey; label: string}> = [
  {key: 'input', label: '输入'},
  {key: 'cache', label: '缓存'},
  {key: 'output', label: '输出'},
  {key: 'requests', label: '次数'},
  {key: 'total', label: '总计'},
]

const props = withDefaults(defineProps<{active?: boolean}>(), {active: true})
const {t, translateLegacy, language} = useUiI18n()
const customOpenAIProviders = ref<CustomOpenAIProvider[]>(config.customOpenAIProviders)
const snapshot = ref<DashboardSnapshot | null>(null)
const selectedService = ref('')
const selectedModel = ref('')
const range = ref<Range>('30d')
const loading = ref(false)
const errorMessage = ref('')
const showAllBreakdown = ref(false)
const trendMetric = ref<UsageTimelineMetric>('tokens')
const selectedPointKey = ref('')
const requestLogOpen = ref(false)
const outcomeLegend = [{key: 'success', label: '成功'}, {key: 'error', label: '错误'}, {key: 'timeout', label: '超时'}, {key: 'cancelled', label: '取消'}]
const breakdownSort = ref<BreakdownSortKey>('total')
const requestPurpose = ref<RequestPurposeFilter>('')
const requestOutcome = ref<RequestOutcomeFilter>('')
const requestCacheStatus = ref<RequestCacheFilter>('')
const requestLogItems = ref<StoredModelUsageEvent[]>([])
const requestLogNextCursor = ref<ModelUsageRequestCursor | null>(null)
const requestLogTotalCount = ref(0)
const requestPageSize = ref<number>(MODEL_USAGE_REQUEST_PAGE_SIZE)
const requestPageIndex = ref(0)
const requestPageCursors = ref<Array<ModelUsageRequestCursor | null>>([null])
const requestLogRetryPageIndex = ref(0)
const requestLogLoading = ref(false)
const requestLogError = ref('')
const resetMessage = ref('')
const resetDialogOpen = ref(false)
const resetting = ref(false)
const resetError = ref('')
const rangeControl = ref<HTMLElement | null>(null)
const resetDialog = ref<HTMLElement | null>(null)
const resetCancelButton = ref<HTMLButtonElement | null>(null)
const resetButton = ref<HTMLButtonElement | null>(null)
let dashboardRevision = 0
let requestLogRevision = 0
let mounted = false
const unsubscribeConfig = subscribeConfig(nextConfig => {
  customOpenAIProviders.value = nextConfig.customOpenAIProviders.map(provider => ({
    ...provider,
    models: [...provider.models],
  }))
})

const selectedTotals = computed<Totals>(() => snapshot.value!.selected.totals)
const appliedFilter = computed<Filter>(() => snapshot.value?.selected.filter || {range: range.value})
const appliedRangeLabel = computed(() => (
  rangeOptions.find(option => option.value === appliedFilter.value.range)?.label || '30 天'
))
const serviceOptions = computed(() => (snapshot.value?.dimensions || []).map(dimension => ({
  id: dimension.serviceId,
  label: serviceLabel(dimension.serviceId),
})))
const modelOptions = computed(() => {
  const dimensions = snapshot.value?.dimensions || []
  const source = selectedService.value
    ? dimensions.filter(dimension => dimension.serviceId === selectedService.value)
    : dimensions
  return [...new Set(source.flatMap(dimension => dimension.models))]
    .sort((left, right) => modelLabel(left).localeCompare(modelLabel(right), language.value))
})
const appliedScopeLabel = computed(() => {
  const service = appliedFilter.value.serviceId ? serviceLabel(appliedFilter.value.serviceId) : '全部 AI 服务'
  return appliedFilter.value.model ? `${service} · ${modelLabel(appliedFilter.value.model)}` : service
})
const hasActiveFilter = computed(() => Boolean(
  appliedFilter.value.serviceId || appliedFilter.value.model || appliedFilter.value.range !== '30d',
))
const hasSelectedUsage = computed(() => selectedTotals.value.requestCount > 0)
const health = computed(() => buildUsageHealth(selectedTotals.value))
const composition = computed(() => buildUsageComposition(selectedTotals.value))
const visibleComposition = computed(() => composition.value.segments.filter(segment => segment.tokens > 0))
const hasIncompleteCoverage = computed(() => health.value.unreportedRequests > 0)
const coverageLabel = computed(() => formatUsageRate(health.value.tokenCoverageRate))
const requestPageCount = computed(() => Math.max(1, Math.ceil(
  requestLogTotalCount.value / requestPageSize.value,
)))
const requestPageStart = computed(() => requestLogTotalCount.value > 0
  ? requestPageIndex.value * requestPageSize.value + 1
  : 0)
const requestPageEnd = computed(() => Math.min(
  (requestPageIndex.value + 1) * requestPageSize.value,
  requestLogTotalCount.value,
))
const visibleBreakdown = computed(() => {
  const rows = [...(snapshot.value?.breakdown || [])].sort((left, right) => {
    const value = (totals: Totals) => breakdownSort.value === 'input'
      ? totals.inputTokens
      : breakdownSort.value === 'cache'
        ? totals.cachedInputTokens
        : breakdownSort.value === 'output'
          ? totals.outputTokens
          : breakdownSort.value === 'requests'
            ? totals.requestCount
            : totals.totalTokens
    return value(right.totals) - value(left.totals)
      || right.totals.totalTokens - left.totals.totalTokens
      || right.totals.inputTokens - left.totals.inputTokens
      || right.totals.outputTokens - left.totals.outputTokens
      || right.totals.requestCount - left.totals.requestCount
      || left.serviceId.localeCompare(right.serviceId)
      || left.model.localeCompare(right.model)
  })
  return showAllBreakdown.value ? rows : rows.slice(0, BREAKDOWN_PREVIEW_COUNT)
})
const largestBreakdownTotal = computed(() => Math.max(
  1,
  ...(snapshot.value?.breakdown || []).map(row => row.totals.totalTokens),
))
const timeline = computed(() => buildUsageTimeline((snapshot.value?.timeline || []).filter(point => point.startedAt <= (snapshot.value?.generatedAt || 0)), trendMetric.value))
const timelineRows = computed(() => timeline.value.points)
const timelineLegend = computed(() => [...new Map(timelineRows.value.flatMap(point => point.segments).filter(segment => segment.value > 0).map(segment => [segment.key, segment])).values()])
const timelineHasDifference = computed(() => timelineRows.value.some(point => point.differenceTokens !== 0))
const inspectedPoint = computed(() => timelineRows.value.find(point => point.key === selectedPointKey.value)
  || [...timelineRows.value].reverse().find(point => point.totals.requestCount > 0)
  || timelineRows.value.at(-1))
const trendAriaLabel = computed(() => `${translateLegacy(appliedRangeLabel.value)}${translateLegacy(appliedScopeLabel.value)}用量趋势，${trendMetric.value === 'tokens' ? 'Token' : translateLegacy('请求次数')}`)
function tokenValue(totals: Totals, key: 'totalTokens' | 'inputTokens' | 'outputTokens'): string {
  return totals.requestCount > 0 && totals.reportedTokenRequests === 0 ? '—' : formatToken(totals[key])
}
function exactTokenValue(totals: Totals, key: 'totalTokens' | 'inputTokens' | 'outputTokens'): string {
  return totals.requestCount > 0 && totals.reportedTokenRequests === 0 ? '未上报' : formatNumber(totals[key])
}
function timelinePointLabel(point: typeof timelineRows.value[number]): string {
  return `${point.label}，输入 ${exactTokenValue(point.totals, 'inputTokens')} Token，输出 ${exactTokenValue(point.totals, 'outputTokens')} Token，共 ${exactTokenValue(point.totals, 'totalTokens')} Token，${point.totals.requestCount} 次请求，${point.unreportedRequests} 次未上报`
}
function handleTrendKeydown(event: KeyboardEvent, index: number): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const points = event.currentTarget instanceof HTMLElement
    ? event.currentTarget.closest('ol')?.querySelectorAll<HTMLButtonElement>('.usage-trend-point') : undefined
  if (!points?.length) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? points.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + points.length) % points.length
  points[next].focus()
}
function handleRequestLogToggle(event: Event): void {
  requestLogOpen.value = (event.target as HTMLDetailsElement).open
  if (!loading.value && requestLogOpen.value && !requestLogItems.value.length && !requestLogLoading.value) resetRequestPagination()
}
const recordingStartLabel = computed(() => snapshot.value?.recordingStartedAt
  ? `最早保留记录 ${formatDate(snapshot.value.recordingStartedAt)}`
  : '尚未开始记录')
const generatedAtLabel = computed(() => snapshot.value
  ? t('common.updatedAt', {value: formatDate(snapshot.value.generatedAt)})
  : '')

function serviceLabel(serviceId: string): string {
  return options.services.find(option => option.value === serviceId)?.label
    || getCustomOpenAIProviderLabel(customOpenAIProviders.value, serviceId)
    || '未知服务'
}

function modelLabel(model: string): string {
  return model === 'unknown' ? '未知模型' : model
}

function formatUsageRate(value: number | null): string {
  return formatRate(value, language.value)
}

function formatNumber(value: number): string {
  return numberFormatter.value.format(Number.isFinite(value) && value > 0 ? value : 0)
}

function formatToken(value: number): string {
  return formatTokenCount(value, language.value).compact
}

function tokenExactTitle(value: number): string {
  return `完整数值：${formatTokenCount(value, language.value).exact} Token`
}

function tokenAriaLabel(value: number): string {
  return `${formatTokenCount(value, language.value).exact} Token`
}

function formatAverageValue(value: number | null): string {
  return value === null ? '—' : formatToken(Math.round(value))
}

function averageTokenTitle(value: number | null): string {
  return value === null ? '没有可计算的 Token 明细' : tokenExactTitle(Math.round(value))
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat(language.value, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(timestamp)
}

function formatRequestTime(timestamp: number): string {
  return requestDateFormatter.value.format(timestamp)
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return '—'
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`
  const unit = (value: number, name: 'second' | 'minute') => new Intl.NumberFormat(language.value, {
    style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: 2,
  }).format(value)
  if (durationMs < 60_000) return unit(durationMs / 1_000, 'second')
  const totalSeconds = Math.round(durationMs / 1_000)
  return `${unit(Math.floor(totalSeconds / 60), 'minute')} ${unit(totalSeconds % 60, 'second')}`
}

function purposeLabel(purpose: ModelUsagePurpose): string {
  return purpose === 'writing' ? '写作助手' : purpose === 'page-summary' ? '页面摘要' : purpose === 'connection-test' ? '连接测试' : purpose === 'reading' ? '阅读理解' : '翻译'
}

function outcomeLabel(outcome: ModelUsageOutcome): string {
  return outcome === 'success' ? '成功' : outcome === 'timeout' ? '超时' : outcome === 'cancelled' ? '已取消' : '错误'
}

function usageAvailabilityLabel(availability: StoredModelUsageEvent['usageAvailability']): string {
  return availability === 'malformed' ? '服务商 Token 明细格式异常' : '服务商未返回 Token 明细'
}

function isCacheHit(item: StoredModelUsageEvent): boolean {
  return typeof item.cachedInputTokens === 'number' && item.cachedInputTokens > 0
}

function requestCacheRate(item: StoredModelUsageEvent): number | null {
  if (item.cachedInputTokens === undefined || !item.inputTokens) return null
  return item.cachedInputTokens / item.inputTokens
}

function requestCacheTokenValue(item: StoredModelUsageEvent): string {
  if (item.cachedInputTokens === undefined) return '未上报'
  return `${formatToken(item.cachedInputTokens)} Token`
}

function requestCacheRateLabel(item: StoredModelUsageEvent): string {
  if (item.cachedInputTokens === undefined) return '命中率不可计算'
  return `输入命中率 ${formatUsageRate(requestCacheRate(item))}`
}

function requestCacheTitle(item: StoredModelUsageEvent): string {
  if (item.cachedInputTokens === undefined) return '服务商未返回缓存读取明细'
  return `${tokenExactTitle(item.cachedInputTokens)}；输入 Token 命中率 ${formatUsageRate(requestCacheRate(item))}`
}

function cacheBreakdownTitle(totals: Totals): string {
  if (!totals.cacheReportedRequests) return '服务商未返回缓存读取明细'
  return `${tokenExactTitle(totals.cachedInputTokens)}；Token 命中率 ${formatUsageRate(totals.cacheTokenHitRate)}`
}

function showTimelineLabel(index: number): boolean {
  const count = timelineRows.value.length
  if (count <= 8) return true
  const interval = count <= 14 ? 2 : 5
  return index === 0 || index === count - 1 || index % interval === 0
}

function breakdownShare(totalTokens: number): number {
  if (totalTokens <= 0) return 0
  return (totalTokens / largestBreakdownTotal.value) * 100
}

function handleRangeKeydown(event: KeyboardEvent, currentIndex: number): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  let nextIndex: number
  if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = rangeOptions.length - 1
  else {
    const offset = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1
    nextIndex = (currentIndex + offset + rangeOptions.length) % rangeOptions.length
  }
  range.value = rangeOptions[nextIndex].value
  void nextTick(() => {
    rangeControl.value
      ?.querySelector<HTMLButtonElement>(`button[data-range-index="${nextIndex}"]`)
      ?.focus()
  })
}

function handleServiceChange(): void {
  if (selectedModel.value && !modelOptions.value.includes(selectedModel.value)) selectedModel.value = ''
  showAllBreakdown.value = false
}

function selectBreakdown(serviceId: string, model: string): void {
  selectedService.value = serviceId
  selectedModel.value = model
  showAllBreakdown.value = false
}

function clearFilters(): void {
  selectedService.value = ''
  selectedModel.value = ''
  range.value = '30d'
  requestPurpose.value = ''
  requestOutcome.value = ''
  requestCacheStatus.value = ''
  showAllBreakdown.value = false
}

function currentFilter(): Filter {
  return {
    range: range.value,
    ...(selectedService.value ? {serviceId: selectedService.value} : {}),
    ...(selectedModel.value ? {model: selectedModel.value} : {}),
  }
}

async function loadSnapshot(): Promise<void> {
  const revision = ++dashboardRevision
  requestLogRevision += 1
  requestLogLoading.value = false
  loading.value = true
  errorMessage.value = ''
  try {
    const response = await browser.runtime.sendMessage({
      type: 'modelUsage',
      action: 'query',
      filter: currentFilter(),
    }) as ModelUsageResponse<DashboardSnapshot>
    if (revision !== dashboardRevision) return
    if (response?.success !== true || !response.data) {
      throw new Error(response?.error || '后台没有返回可用的统计快照')
    }
    snapshot.value = response.data
    selectedPointKey.value = ''
    if (response.data.selected.totals.requestCount > 0) void resetRequestPagination()
    else {
      requestLogOpen.value = false
      requestLogRevision += 1
      requestLogLoading.value = false
      requestLogItems.value = []
      requestLogNextCursor.value = null
      requestLogTotalCount.value = 0
      requestPageIndex.value = 0
      requestPageCursors.value = [null]
      requestLogRetryPageIndex.value = 0
    }
  } catch (error) {
    if (revision !== dashboardRevision) return
    errorMessage.value = error instanceof Error ? error.message : '未知错误'
  } finally {
    if (revision === dashboardRevision) loading.value = false
  }
}

function resetRequestPagination(): void {
  requestLogRevision += 1
  requestLogLoading.value = false
  requestLogError.value = ''
  requestLogItems.value = []
  requestLogNextCursor.value = null
  requestLogTotalCount.value = 0
  requestPageIndex.value = 0
  requestPageCursors.value = [null]
  requestLogRetryPageIndex.value = 0
  if (requestLogOpen.value) void loadRequestPage(0)
}

async function loadRequestPage(pageIndex: number): Promise<void> {
  if (!props.active || pageIndex < 0) return
  const cursor = requestPageCursors.value[pageIndex]
  if (pageIndex > 0 && !cursor) return
  const revision = ++requestLogRevision
  requestLogRetryPageIndex.value = pageIndex
  requestLogLoading.value = true
  requestLogError.value = ''
  try {
    const response = await browser.runtime.sendMessage({
      type: 'modelUsage',
      action: 'list',
      query: {
        filter: {
          ...appliedFilter.value,
          ...(requestPurpose.value ? {purpose: requestPurpose.value} : {}),
          ...(requestOutcome.value ? {outcome: requestOutcome.value} : {}),
          ...(requestCacheStatus.value ? {cacheStatus: requestCacheStatus.value} : {}),
        },
        ...(cursor ? {cursor} : {}),
        limit: requestPageSize.value,
      },
    }) as ModelUsageResponse<ModelUsageRequestPage>
    if (revision !== requestLogRevision) return
    if (response?.success !== true || !response.data) {
      throw new Error(response?.error || '后台没有返回请求记录')
    }
    requestLogItems.value = response.data.items
    requestPageIndex.value = pageIndex
    requestLogNextCursor.value = response.data.nextCursor
    // 固定第一页返回的总数，避免持续产生的新请求让当前游标链路的页数发生漂移。
    if (pageIndex === 0) requestLogTotalCount.value = response.data.totalCount
    const cursors = requestPageCursors.value.slice(0, pageIndex + 1)
    if (response.data.nextCursor) cursors[pageIndex + 1] = response.data.nextCursor
    requestPageCursors.value = cursors
  } catch (error) {
    if (revision !== requestLogRevision) return
    requestLogError.value = error instanceof Error ? error.message : '读取请求记录失败'
  } finally {
    if (revision === requestLogRevision) requestLogLoading.value = false
  }
}

function loadNextRequestPage(): void {
  if (!requestLogNextCursor.value) return
  requestPageCursors.value[requestPageIndex.value + 1] = requestLogNextCursor.value
  void loadRequestPage(requestPageIndex.value + 1)
}
async function openResetDialog(): Promise<void> {
  resetError.value = ''
  resetMessage.value = ''
  setSettingsBackgroundInert(true)
  resetDialogOpen.value = true
  await nextTick()
  resetCancelButton.value?.focus()
}

function closeResetDialog(): void {
  if (resetting.value) return
  resetDialogOpen.value = false
  setSettingsBackgroundInert(false)
  resetError.value = ''
  void nextTick(() => resetButton.value?.focus())
}

function setSettingsBackgroundInert(value: boolean): void {
  const settingsApp = document.querySelector<HTMLElement>('.settings-app')
  if (value) settingsApp?.setAttribute('inert', '')
  else settingsApp?.removeAttribute('inert')
}

function handleResetDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeResetDialog()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = [...(resetDialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])]
  if (!focusable.length) {
    event.preventDefault()
    resetDialog.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)!
  if (event.shiftKey && (document.activeElement === first || document.activeElement === resetDialog.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function resetUsage(): Promise<void> {
  if (resetting.value) return
  resetting.value = true
  resetError.value = ''
  try {
    const response = await browser.runtime.sendMessage({type: 'modelUsage', action: 'reset'}) as ModelUsageResponse<{cleared?: boolean}>
    if (response?.success !== true) throw new Error(response?.error || '后台没有确认清除结果')
    resetDialogOpen.value = false
    setSettingsBackgroundInert(false)
    resetMessage.value = '模型用量请求记录及汇总已清除。'
    await loadSnapshot()
    await nextTick()
    resetButton.value?.focus()
  } catch (error) {
    resetError.value = error instanceof Error ? error.message : '清除统计失败'
  } finally {
    resetting.value = false
  }
}

watch([selectedService, selectedModel, range], () => {
  if (!mounted || !props.active) return
  void loadSnapshot()
}, {flush: 'post'})

watch([requestPurpose, requestOutcome, requestCacheStatus, requestPageSize], () => {
  if (!mounted || !props.active || !snapshot.value || loading.value) return
  resetRequestPagination()
}, {flush: 'post'})

watch(() => props.active, (active, previous) => {
  if (!mounted || !active || previous === active) return
  void loadSnapshot()
})

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible' && props.active) void loadSnapshot()
}

onMounted(() => {
  mounted = true
  document.addEventListener('visibilitychange', handleVisibilityChange)
  if (props.active) void loadSnapshot()
})

onBeforeUnmount(() => {
  mounted = false
  dashboardRevision += 1
  requestLogRevision += 1
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  unsubscribeConfig()
  setSettingsBackgroundInert(false)
})
</script>

<style scoped src="./model-usage-dashboard.css"></style>
