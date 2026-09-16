<!--
 @file src/features/translation-stats/ui/TranslationStatsDashboard.vue
 文件职责：在 Options 设置页展示翻译请求统计，帮助用户了解请求规模、耗时分布和各翻译服务的表现。
 主要内容：提供服务、模型与时间范围筛选，呈现请求量、文本量、耗时和缓存复用概览，可切换指标的趋势柱图，可排序的服务表现与免费线路表，耗时与规模分布、失败原因，以及可按来源、状态与耗时排序的请求记录和清除统计确认。
 模块边界：组件只通过后台 translationStats 消息读取数值快照与记录，不直接访问 IndexedDB、不发起翻译，也不修改翻译设置；聚合、持久化与采集分别由 services、platform/storage 和翻译 broker 负责。
-->
<template>
  <section id="settings-translation-stats" class="translation-stats" :aria-label="t('translationStats.aria.dashboard')">
    <div class="stats-toolbar">
      <div class="stats-filters" :aria-label="t('translationStats.aria.filters')">
        <label class="stats-filter">
          <span>{{ t('translationStats.filter.service') }}</span>
          <div class="stats-select-shell">
            <ServiceIcon v-if="selectedService" :service="selectedService" :label="serviceLabel(selectedService)" size="small" />
            <UiSelect v-model="selectedService" :aria-label="t('translationStats.filter.service')" :placeholder="t('translationStats.filter.allServices')" @change="handleServiceChange">
              <ElOption value="" :label="t('translationStats.filter.allServices')" />
              <ElOption v-for="service in serviceOptions" :key="service.id" :value="service.id" :label="service.label" />
            </UiSelect>
          </div>
        </label>
        <label v-if="modelOptions.length" class="stats-filter">
          <span>{{ t('translationStats.filter.model') }}</span>
          <div class="stats-select-shell">
            <UiSelect v-model="selectedModel" :aria-label="t('translationStats.filter.model')">
              <ElOption :value="ALL_MODELS" :label="t('translationStats.filter.allModels')" />
              <ElOption v-for="model in modelOptions" :key="model" :value="model" :label="model" />
            </UiSelect>
          </div>
        </label>
        <div class="stats-filter">
          <span>{{ t('translationStats.filter.range') }}</span>
          <div ref="rangeControl" class="stats-range" role="radiogroup" :aria-label="t('translationStats.filter.range')">
            <button
              v-for="(option, index) in rangeOptions"
              :key="option"
              type="button"
              role="radio"
              :data-range-index="index"
              :aria-checked="range === option"
              :tabindex="range === option ? 0 : -1"
              :class="{active: range === option}"
              @click="range = option"
              @keydown="handleRangeKeydown($event, index)"
            >{{ t(`translationStats.range.${option}`) }}</button>
          </div>
        </div>
      </div>
      <div class="stats-actions">
        <button type="button" class="stats-button" :disabled="loading" @click="loadSnapshot">
          {{ loading ? t('translationStats.refreshing') : t('translationStats.refresh') }}
        </button>
        <button ref="resetButton" type="button" class="stats-button stats-button-quiet" @click="openResetDialog">
          {{ t('translationStats.reset.action') }}
        </button>
      </div>
    </div>

    <div class="stats-meta">
      <span v-if="snapshot">{{ t('common.updatedAt', {value: formatDateTime(snapshot.generatedAt)}) }}</span>
      <span v-if="snapshot?.recordingStartedAt">{{ t('translationStats.recordingSince', {value: formatDateTime(snapshot.recordingStartedAt)}) }}</span>
      <button v-if="hasActiveFilter" type="button" class="stats-link" @click="clearFilters">{{ t('translationStats.filter.reset') }}</button>
    </div>

    <p v-if="resetMessage" class="stats-notice" role="status">{{ resetMessage }}</p>
    <p v-if="errorMessage && snapshot" class="stats-inline-error" role="status">
      <span>{{ errorMessage }}</span>
      <button type="button" class="stats-link" @click="loadSnapshot">{{ t('translationStats.retry') }}</button>
    </p>

    <div v-if="loading && !snapshot" class="stats-state" aria-live="polite">
      <span class="stats-loader" aria-hidden="true"></span>
      <strong>{{ t('translationStats.loading') }}</strong>
    </div>

    <div v-else-if="errorMessage && !snapshot" class="stats-state stats-state-error" role="alert">
      <strong>{{ t('translationStats.loadFailed') }}</strong>
      <p>{{ errorMessage }}</p>
      <button type="button" class="stats-button" @click="loadSnapshot">{{ t('translationStats.reload') }}</button>
    </div>

    <template v-else-if="snapshot">
      <div class="stats-summary" :aria-busy="loading">
        <article class="stats-card">
          <span class="stats-card-label">{{ t('translationStats.card.requests') }}</span>
          <strong class="stats-card-value">{{ formatNumber(totals.requestCount) }}</strong>
          <div class="stats-meter" aria-hidden="true"><span :style="{width: `${(totals.successRate ?? 0) * 100}%`}"></span></div>
          <small>{{ t('translationStats.card.successRate', {value: formatPercent(totals.successRate)}) }}</small>
          <small class="stats-outcomes">
            <span>{{ t('translationStats.outcome.successCount', {count: formatNumber(totals.outcomes.success)}) }}</span>
            <span>{{ t('translationStats.outcome.failedCount', {count: formatNumber(totals.outcomes.error + totals.outcomes.timeout)}) }}</span>
            <span>{{ t('translationStats.outcome.cancelledCount', {count: formatNumber(totals.outcomes.cancelled)}) }}</span>
          </small>
        </article>

        <article class="stats-card">
          <span class="stats-card-label">{{ t('translationStats.card.volume') }}</span>
          <strong class="stats-card-value" :title="t('translationStats.charsValue', {value: formatNumber(totals.sourceChars)})">
            {{ formatCompact(totals.sourceChars) }}<em>{{ t('translationStats.unit.chars') }}</em>
          </strong>
          <small>{{ t('translationStats.card.averageSize', {value: formatAverage(totals.averageSourceChars)}) }}</small>
          <small>{{ t('translationStats.card.segmentsAndBytes', {segments: formatNumber(totals.segmentCount), size: formatBytes(totals.sourceBytes)}) }}</small>
        </article>

        <article class="stats-card">
          <span class="stats-card-label">{{ t('translationStats.card.latency') }}</span>
          <strong class="stats-card-value">{{ formatDuration(totals.averageDurationMs) }}</strong>
          <template v-if="totals.latencyCount">
            <small>{{ t('translationStats.card.latencyRange', {p95: formatDuration(totals.p95DurationMs), max: formatDuration(totals.maxDurationMs)}) }}</small>
            <small>{{ t('translationStats.card.upstream', {value: formatDuration(totals.averageUpstreamMs)}) }}</small>
          </template>
          <small v-else>{{ t('translationStats.card.latencyEmpty') }}</small>
        </article>

        <article class="stats-card">
          <span class="stats-card-label">{{ t('translationStats.card.reuse') }}</span>
          <strong class="stats-card-value">{{ formatPercent(totals.reuseRate) }}</strong>
          <small>{{ t('translationStats.card.reuseCache', {count: formatNumber(totals.sources.cache + totals.sources.partial)}) }}</small>
          <small>{{ t('translationStats.card.reuseShared', {count: formatNumber(totals.sources.shared)}) }}</small>
        </article>
      </div>

      <div v-if="!totals.requestCount" class="stats-state stats-state-empty">
        <span class="stats-empty-icon" aria-hidden="true"><UiIcon name="gauge" :size="24" /></span>
        <strong>{{ hasActiveFilter ? t('translationStats.emptyFiltered.title') : t('translationStats.empty.title') }}</strong>
        <p>{{ hasActiveFilter ? t('translationStats.emptyFiltered.description') : t('translationStats.empty.description') }}</p>
        <button v-if="hasActiveFilter" type="button" class="stats-button" @click="clearFilters">{{ t('translationStats.emptyFiltered.action') }}</button>
      </div>

      <template v-else>
        <figure class="stats-card stats-trend">
          <figcaption class="stats-card-header">
            <div>
              <span class="stats-card-label">{{ trendScaleLabel }}</span>
              <strong>{{ t('translationStats.trend.title') }}</strong>
            </div>
            <div class="stats-toggle" role="group" :aria-label="t('translationStats.aria.trendMetric')">
              <button
                v-for="metric in trendMetrics"
                :key="metric"
                type="button"
                :aria-pressed="trendMetric === metric"
                @click="trendMetric = metric"
              >{{ t(`translationStats.trend.metric.${metric}`) }}</button>
            </div>
          </figcaption>
          <div class="stats-trend-scale"><span>{{ trendMaximumLabel }}</span></div>
          <ol class="stats-trend-plot" :style="{gridTemplateColumns: `repeat(${trend.bars.length}, minmax(0, 1fr))`}">
            <li v-for="(bar, index) in trend.bars" :key="bar.key">
              <button
                type="button"
                class="stats-trend-bar"
                :class="{selected: inspectedBar?.key === bar.key}"
                :aria-label="trendBarLabel(bar)"
                :aria-pressed="inspectedBar?.key === bar.key"
                @click="selectedBarKey = bar.key"
                @focus="selectedBarKey = bar.key"
                @keydown="handleTrendKeydown($event, index)"
              >
                <span class="stats-trend-track" aria-hidden="true">
                  <span class="stats-trend-fill" :class="`is-${trendMetric}`" :style="{height: `${bar.height}%`}">
                    <span v-for="segment in bar.segments" :key="segment.key" :class="`is-${segment.key}`" :style="{height: `${segment.share * 100}%`}"></span>
                  </span>
                </span>
              </button>
              <span class="stats-trend-label" :class="{muted: !showTrendLabel(index)}" aria-hidden="true">{{ showTrendLabel(index) ? bar.label : '·' }}</span>
            </li>
          </ol>
          <div v-if="inspectedBar" class="stats-trend-inspector" aria-live="polite">
            <strong>{{ inspectedBar.label }}</strong>
            <span>{{ t('translationStats.trend.requests', {count: formatNumber(inspectedBar.totals.requestCount)}) }}</span>
            <span>{{ t('translationStats.trend.failed', {count: formatNumber(inspectedBar.totals.outcomes.error + inspectedBar.totals.outcomes.timeout)}) }}</span>
            <span>{{ t('translationStats.trend.latency', {value: formatDuration(inspectedBar.totals.averageDurationMs)}) }}</span>
            <span>{{ t('translationStats.charsValue', {value: formatNumber(inspectedBar.totals.sourceChars)}) }}</span>
          </div>
          <div v-if="trendMetric === 'requests'" class="stats-legend">
            <span v-for="key in trendSegmentKeys" :key="key"><i :class="`is-${key}`"></i>{{ t(`translationStats.trend.segment.${key}`) }}</span>
          </div>
        </figure>

        <section class="stats-card stats-services" aria-labelledby="stats-services-title">
          <header class="stats-card-header">
            <div>
              <span class="stats-card-label">{{ t('translationStats.services.subtitle') }}</span>
              <strong id="stats-services-title">{{ t('translationStats.services.title') }}</strong>
            </div>
            <small>{{ t('translationStats.services.hint') }}</small>
          </header>
          <div class="stats-table-wrap">
            <table class="stats-table stats-service-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('translationStats.services.column.service') }}</th>
                  <th v-for="column in breakdownColumns" :key="column" scope="col" :aria-sort="breakdownAriaSort(column)">
                    <button type="button" class="stats-sort" :class="{active: breakdownSort === column}" @click="toggleBreakdownSort(column)">
                      {{ column === 'p95' ? 'P95' : t(`translationStats.services.column.${column}`) }}<i aria-hidden="true">{{ breakdownSort === column ? (breakdownDirection === 'asc' ? '↑' : '↓') : '' }}</i>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in visibleBreakdown"
                  :key="`${row.serviceId}:${row.model}`"
                  :class="{active: isBreakdownActive(row)}"
                  tabindex="0"
                  @click="selectBreakdown(row)"
                  @keydown.enter.prevent="selectBreakdown(row)"
                  @keydown.space.prevent="selectBreakdown(row)"
                >
                  <th scope="row">
                    <span class="stats-service">
                      <ServiceIcon :service="row.serviceId" :label="serviceLabel(row.serviceId)" size="small" />
                      <span>
                        <strong>{{ serviceLabel(row.serviceId) }}</strong>
                        <small v-if="row.model">{{ row.model }}</small>
                        <small v-if="row.totals.charsPerSecond !== null" class="stats-speed">{{ t('translationStats.services.speed', {value: formatNumber(row.totals.charsPerSecond)}) }}</small>
                      </span>
                    </span>
                  </th>
                  <td :data-label="t('translationStats.services.column.requests')">{{ formatNumber(row.totals.requestCount) }}</td>
                  <td :data-label="t('translationStats.services.column.successRate')" :class="{warning: (row.totals.successRate ?? 1) < 0.95}">{{ formatPercent(row.totals.successRate) }}</td>
                  <td :data-label="t('translationStats.services.column.average')">{{ formatDuration(row.totals.averageDurationMs) }}</td>
                  <td data-label="P95">{{ formatDuration(row.totals.p95DurationMs) }}</td>
                  <td :data-label="t('translationStats.services.column.max')">{{ formatDuration(row.totals.maxDurationMs) }}</td>
                  <td :data-label="t('translationStats.services.column.size')">{{ formatAverage(row.totals.averageSourceChars) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <button
            v-if="snapshot.breakdown.length > BREAKDOWN_PREVIEW_COUNT"
            type="button"
            class="stats-link stats-show-all"
            :aria-expanded="showAllBreakdown"
            @click="showAllBreakdown = !showAllBreakdown"
          >{{ showAllBreakdown ? t('translationStats.services.collapse') : t('translationStats.services.showAll', {count: snapshot.breakdown.length}) }}</button>
          <p class="stats-footnote">{{ t('translationStats.services.latencyNote') }}</p>
        </section>

        <section v-if="snapshot.routes.length" class="stats-card stats-services stats-routes" aria-labelledby="stats-routes-title">
          <header class="stats-card-header">
            <div>
              <span class="stats-card-label">{{ t('translationStats.routes.subtitle') }}</span>
              <strong id="stats-routes-title">{{ t('translationStats.routes.title') }}</strong>
            </div>
          </header>
          <div class="stats-table-wrap">
            <table class="stats-table stats-route-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('translationStats.routes.column.route') }}</th>
                  <th v-for="column in routeColumns" :key="column" scope="col" :aria-sort="routeAriaSort(column)">
                    <button type="button" class="stats-sort" :class="{active: routeSort === column}" @click="toggleRouteSort(column)">
                      {{ column === 'p95' ? 'P95' : t(`translationStats.routes.column.${column}`) }}<i aria-hidden="true">{{ routeSort === column ? (routeDirection === 'asc' ? '↑' : '↓') : '' }}</i>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in visibleRoutes" :key="`${row.serviceId}:${row.route}`">
                  <th scope="row">
                    <span class="stats-service">
                      <ServiceIcon :service="row.route" :label="routeLabel(row.route)" size="small" />
                      <span><strong>{{ routeLabel(row.route) }}</strong></span>
                    </span>
                  </th>
                  <td :data-label="t('translationStats.routes.column.attempts')">{{ formatNumber(row.totals.attemptCount) }}</td>
                  <td :data-label="t('translationStats.routes.column.successRate')" :class="{warning: (row.totals.successRate ?? 1) < 0.95}">{{ formatPercent(row.totals.successRate) }}</td>
                  <td :data-label="t('translationStats.routes.column.average')">{{ formatDuration(row.totals.averageDurationMs) }}</td>
                  <td data-label="P95">{{ formatDuration(row.totals.p95DurationMs) }}</td>
                  <td :data-label="t('translationStats.routes.column.max')">{{ formatDuration(row.totals.maxDurationMs) }}</td>
                  <td :data-label="t('translationStats.routes.column.size')">{{ formatAverage(row.totals.averageChars) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="stats-footnote">{{ t('translationStats.routes.note') }}</p>
        </section>

        <div class="stats-distribution-grid">
          <section class="stats-card" aria-labelledby="stats-duration-title">
            <header class="stats-card-header">
              <div>
                <span class="stats-card-label">{{ t('translationStats.distribution.durationSubtitle') }}</span>
                <strong id="stats-duration-title">{{ t('translationStats.distribution.duration') }}</strong>
              </div>
              <small>{{ t('translationStats.distribution.median', {value: formatDuration(totals.medianDurationMs)}) }}</small>
            </header>
            <ul v-if="durationRows.total" class="stats-histogram">
              <li v-for="row in trimHistogramRows(durationRows.rows)" :key="row.index">
                <span>{{ bucketLabel(row, 'duration') }}</span>
                <i aria-hidden="true"><b :style="{width: `${row.ratio * 100}%`}"></b></i>
                <strong>{{ formatNumber(row.count) }}</strong>
                <small>{{ formatPercent(row.share) }}</small>
              </li>
            </ul>
            <p v-else class="stats-footnote">{{ t('translationStats.card.latencyEmpty') }}</p>
          </section>

          <section class="stats-card" aria-labelledby="stats-size-title">
            <header class="stats-card-header">
              <div>
                <span class="stats-card-label">{{ t('translationStats.distribution.sizeSubtitle') }}</span>
                <strong id="stats-size-title">{{ t('translationStats.distribution.size') }}</strong>
              </div>
              <small>{{ t('translationStats.distribution.largest', {value: t('translationStats.charsValue', {value: formatNumber(totals.maxSourceChars)})}) }}</small>
            </header>
            <ul class="stats-histogram is-size">
              <li v-for="row in trimHistogramRows(sizeRows.rows)" :key="row.index">
                <span>{{ bucketLabel(row, 'size') }}</span>
                <i aria-hidden="true"><b :style="{width: `${row.ratio * 100}%`}"></b></i>
                <strong>{{ formatNumber(row.count) }}</strong>
                <small>{{ formatPercent(row.share) }}</small>
              </li>
            </ul>
          </section>

          <section class="stats-card" aria-labelledby="stats-failure-title">
            <header class="stats-card-header">
              <div>
                <span class="stats-card-label">{{ t('translationStats.failures.subtitle') }}</span>
                <strong id="stats-failure-title">{{ t('translationStats.failures.title') }}</strong>
              </div>
            </header>
            <ul v-if="errorRows.length" class="stats-failures">
              <li v-for="row in errorRows" :key="row.kind">
                <span>{{ t(`translationStats.errorKind.${row.kind}`) }}</span>
                <strong>{{ formatNumber(row.count) }}</strong>
                <small>{{ formatPercent(row.share) }}</small>
              </li>
            </ul>
            <p v-else class="stats-footnote">{{ t('translationStats.failures.empty') }}</p>
          </section>
        </div>

        <section class="stats-card stats-log" aria-labelledby="stats-log-title" :aria-busy="logLoading">
          <header class="stats-card-header stats-log-header">
            <div>
              <span class="stats-card-label">{{ t('translationStats.log.subtitle', {count: formatNumber(TRANSLATION_STATS_MAX_STORED_REQUESTS)}) }}</span>
              <strong id="stats-log-title">{{ t('translationStats.log.title') }}</strong>
              <small v-if="logTotal">{{ t('translationStats.log.range', {start: formatNumber(logRange.start), end: formatNumber(logRange.end), total: formatNumber(logTotal)}) }}</small>
            </div>
            <div class="stats-log-filters">
              <label>
                <span>{{ t('translationStats.log.source') }}</span>
                <UiSelect v-model="logSource" :disabled="logLoading" :aria-label="t('translationStats.log.source')" :placeholder="t('translationStats.log.allSources')">
                  <ElOption value="" :label="t('translationStats.log.allSources')" />
                  <ElOption v-for="source in TRANSLATION_REQUEST_SOURCES" :key="source" :value="source" :label="t(`translationStats.source.${source}`)" />
                </UiSelect>
              </label>
              <label>
                <span>{{ t('translationStats.log.outcome') }}</span>
                <UiSelect v-model="logOutcome" :disabled="logLoading" :aria-label="t('translationStats.log.outcome')" :placeholder="t('translationStats.log.allOutcomes')">
                  <ElOption value="" :label="t('translationStats.log.allOutcomes')" />
                  <ElOption v-for="outcome in TRANSLATION_REQUEST_OUTCOMES" :key="outcome" :value="outcome" :label="t(`translationStats.outcome.${outcome}`)" />
                </UiSelect>
              </label>
              <div class="stats-toggle" role="group" :aria-label="t('translationStats.log.sort')">
                <button type="button" :aria-pressed="logSort === 'recent'" :disabled="logLoading" @click="logSort = 'recent'">{{ t('translationStats.log.sortRecent') }}</button>
                <button type="button" :aria-pressed="logSort === 'slowest'" :disabled="logLoading" @click="logSort = 'slowest'">{{ t('translationStats.log.sortSlowest') }}</button>
              </div>
            </div>
          </header>

          <p v-if="logError" class="stats-inline-error" role="alert">
            <span>{{ logError }}</span>
            <button type="button" class="stats-link" :disabled="logLoading" @click="loadRequestPage(logOffset)">{{ t('translationStats.retry') }}</button>
          </p>
          <p v-if="logLoading && !logItems.length" class="stats-footnote" role="status">{{ t('translationStats.log.loading') }}</p>
          <p v-else-if="!logItems.length && !logError" class="stats-footnote">{{ t('translationStats.log.empty') }}</p>
          <div v-else class="stats-table-wrap">
            <table class="stats-table stats-log-table">
              <thead>
                <tr>
                  <th scope="col">{{ t('translationStats.log.column.time') }}</th>
                  <th scope="col">{{ t('translationStats.services.column.service') }}</th>
                  <th scope="col">{{ t('translationStats.log.column.size') }}</th>
                  <th scope="col">{{ t('translationStats.log.source') }}</th>
                  <th scope="col">{{ t('translationStats.log.outcome') }}</th>
                  <th scope="col">{{ t('translationStats.log.column.duration') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in logItems" :key="item.id">
                  <td :data-label="t('translationStats.log.column.time')">
                    <time :datetime="new Date(item.startedAt).toISOString()">{{ formatRequestTime(item.startedAt) }}</time>
                  </td>
                  <td :data-label="t('translationStats.services.column.service')">
                    <span class="stats-service">
                      <ServiceIcon :service="item.serviceId" :label="serviceLabel(item.serviceId)" size="small" />
                      <span>
                        <strong>{{ serviceLabel(item.serviceId) }}</strong>
                        <small v-if="item.model">{{ item.model }}</small>
                        <small v-else-if="item.routes.length">{{ routeSummary(item.routes) }}</small>
                      </span>
                    </span>
                  </td>
                  <td :data-label="t('translationStats.log.column.size')">
                    <span class="stats-cell-stack">
                      <strong>{{ t('translationStats.charsValue', {value: formatNumber(item.sourceChars)}) }}</strong>
                      <small>{{ requestShapeLabel(item) }}</small>
                    </span>
                  </td>
                  <td :data-label="t('translationStats.log.source')">
                    <span class="stats-badge" :class="`is-${item.source}`">{{ t(`translationStats.source.${item.source}`) }}</span>
                  </td>
                  <td :data-label="t('translationStats.log.outcome')">
                    <span class="stats-cell-stack">
                      <strong class="stats-outcome" :class="`is-${item.outcome}`">{{ t(`translationStats.outcome.${item.outcome}`) }}</strong>
                      <small v-if="item.errorKind">{{ t(`translationStats.errorKind.${item.errorKind}`) }}<template v-if="item.statusCode"> · HTTP {{ item.statusCode }}</template></small>
                    </span>
                  </td>
                  <td :data-label="t('translationStats.log.column.duration')">
                    <span class="stats-cell-stack">
                      <strong>{{ formatDuration(item.durationMs) }}</strong>
                      <small v-if="item.upstreamCalls">{{ t('translationStats.log.upstream', {value: formatDuration(item.upstreamMs), count: formatNumber(item.upstreamCalls)}) }}</small>
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <footer v-if="logTotal" class="stats-log-footer">
            <label class="stats-page-size">
              <span>{{ t('translationStats.log.pageSize') }}</span>
              <UiSelect v-model="logPageSize" :disabled="logLoading" :aria-label="t('translationStats.log.pageSize')">
                <ElOption v-for="size in pageSizeOptions" :key="size" :value="size" :label="formatNumber(size)" />
              </UiSelect>
            </label>
            <nav class="stats-pagination" :aria-label="t('translationStats.log.pagination')">
              <button type="button" class="stats-button" :disabled="logLoading || logRange.pageIndex === 0" @click="loadRequestPage(logOffset - logPageSize)">{{ t('translationStats.log.previous') }}</button>
              <span>{{ t('translationStats.log.page', {page: logRange.pageIndex + 1, pages: logRange.pageCount}) }}</span>
              <button type="button" class="stats-button" :disabled="logLoading || logRange.end >= logTotal" @click="loadRequestPage(logOffset + logPageSize)">{{ t('translationStats.log.next') }}</button>
            </nav>
          </footer>
        </section>
      </template>
    </template>

    <Teleport to="body">
      <div v-if="resetDialogOpen" class="stats-dialog-backdrop" @click.self="closeResetDialog">
        <section
          ref="resetDialog"
          class="stats-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="stats-reset-title"
          aria-describedby="stats-reset-description"
          tabindex="-1"
          @keydown="handleDialogKeydown"
        >
          <h2 id="stats-reset-title">{{ t('translationStats.reset.title') }}</h2>
          <p id="stats-reset-description">{{ t('translationStats.reset.description') }}</p>
          <p v-if="resetError" class="stats-inline-error" role="alert">{{ resetError }}</p>
          <div class="stats-dialog-actions">
            <button ref="resetCancelButton" type="button" class="stats-button" :disabled="resetting" @click="closeResetDialog">{{ t('translationStats.reset.cancel') }}</button>
            <button type="button" class="stats-button stats-button-danger" :disabled="resetting" @click="resetStats">
              {{ resetting ? t('translationStats.reset.clearing') : t('translationStats.reset.confirm') }}
            </button>
          </div>
        </section>
      </div>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue'
import browser from 'webextension-polyfill'
import {ElOption} from 'element-plus'
import UiIcon from '@/src/ui/components/UiIcon.vue'
import UiSelect from '@/src/ui/components/UiSelect.vue'
import ServiceIcon from '@/src/ui/components/ServiceIcon.vue'
import {useUiI18n} from '@/src/ui/i18n'
import {options} from '@/src/core/config/catalog'
import {getCustomOpenAIProviderLabel, type CustomOpenAIProvider} from '@/src/core/config/customOpenAI'
import {FREE_TRANSLATION_PROVIDERS} from '@/src/core/config/freeTranslation'
import {config, subscribeConfig} from '@/src/services/config/store'
import {
  TRANSLATION_REQUEST_OUTCOMES,
  TRANSLATION_REQUEST_SOURCES,
  TRANSLATION_STATS_DURATION_BOUNDS_MS,
  TRANSLATION_STATS_MAX_STORED_REQUESTS,
  TRANSLATION_STATS_REQUEST_PAGE_SIZE,
  TRANSLATION_STATS_SIZE_BOUNDS_CHARS,
  type StoredTranslationRequestEvent,
  type TranslationRequestOutcome,
  type TranslationRequestSource,
  type TranslationStatsBreakdownItem,
  type TranslationStatsFilter,
  type TranslationStatsRange,
  type TranslationStatsRequestPage,
  type TranslationStatsRequestSort,
  type TranslationStatsSnapshot,
  type TranslationStatsTotals,
} from '@/src/services/translation-stats/types'
import {
  buildErrorKindRows,
  buildHistogramRows,
  buildTrendBars,
  formatStatsBytes,
  formatStatsCompact,
  formatStatsDuration,
  formatStatsNumber,
  formatStatsPercent,
  requestPageRange,
  sortBreakdown,
  sortRoutes,
  trimHistogramRows,
  type TranslationStatsBreakdownSortKey,
  type TranslationStatsHistogramRow,
  type TranslationStatsSortDirection,
  type TranslationRouteSortKey,
  type TranslationStatsTrendBar,
  type TranslationStatsTrendMetric,
} from '../model/presentation'

type StatsResponse<T> = {success?: boolean; data?: T; error?: string}

const ALL_MODELS = '__all_models__'
const BREAKDOWN_PREVIEW_COUNT = 8
const rangeOptions: readonly TranslationStatsRange[] = ['today', '7d', '30d']
const trendMetrics: readonly TranslationStatsTrendMetric[] = ['requests', 'latency', 'chars']
const trendSegmentKeys = ['success', 'failed', 'cancelled'] as const
const breakdownColumns: readonly TranslationStatsBreakdownSortKey[] = ['requests', 'successRate', 'average', 'p95', 'max', 'size']
const routeColumns: readonly TranslationRouteSortKey[] = ['attempts', 'successRate', 'average', 'p95', 'max', 'size']
const pageSizeOptions = [TRANSLATION_STATS_REQUEST_PAGE_SIZE, 50, 100] as const

const props = withDefaults(defineProps<{active?: boolean}>(), {active: true})
const {t, translateLegacy, language} = useUiI18n()

const customOpenAIProviders = ref<CustomOpenAIProvider[]>(config.customOpenAIProviders)
const snapshot = ref<TranslationStatsSnapshot | null>(null)
const loading = ref(false)
const errorMessage = ref('')
const selectedService = ref('')
const selectedModel = ref(ALL_MODELS)
const range = ref<TranslationStatsRange>('7d')
const trendMetric = ref<TranslationStatsTrendMetric>('requests')
const selectedBarKey = ref('')
const breakdownSort = ref<TranslationStatsBreakdownSortKey>('requests')
const breakdownDirection = ref<TranslationStatsSortDirection>('desc')
const routeSort = ref<TranslationRouteSortKey>('attempts')
const routeDirection = ref<TranslationStatsSortDirection>('desc')
const showAllBreakdown = ref(false)
const logItems = ref<StoredTranslationRequestEvent[]>([])
const logTotal = ref(0)
const logOffset = ref(0)
const logPageSize = ref<number>(TRANSLATION_STATS_REQUEST_PAGE_SIZE)
const logSource = ref<'' | TranslationRequestSource>('')
const logOutcome = ref<'' | TranslationRequestOutcome>('')
const logSort = ref<TranslationStatsRequestSort>('recent')
const logLoading = ref(false)
const logError = ref('')
const resetDialogOpen = ref(false)
const resetting = ref(false)
const resetError = ref('')
const resetMessage = ref('')
const rangeControl = ref<HTMLElement | null>(null)
const resetDialog = ref<HTMLElement | null>(null)
const resetButton = ref<HTMLButtonElement | null>(null)
const resetCancelButton = ref<HTMLButtonElement | null>(null)
let snapshotRevision = 0
let logRevision = 0
let mounted = false

const unsubscribeConfig = subscribeConfig((nextConfig) => {
  customOpenAIProviders.value = nextConfig.customOpenAIProviders.map((provider) => ({...provider, models: [...provider.models]}))
})

const totals = computed<TranslationStatsTotals>(() => snapshot.value!.selected.totals)
const appliedFilter = computed<TranslationStatsFilter>(() => snapshot.value?.selected.filter ?? {range: range.value})
const serviceOptions = computed(() => (snapshot.value?.dimensions ?? []).map((dimension) => ({
  id: dimension.serviceId,
  label: serviceLabel(dimension.serviceId),
})).sort((left, right) => left.label.localeCompare(right.label, language.value)))
const modelOptions = computed(() => selectedService.value
  ? (snapshot.value?.dimensions.find((dimension) => dimension.serviceId === selectedService.value)?.models ?? []).filter(Boolean)
  : [])
const hasActiveFilter = computed(() => Boolean(appliedFilter.value.serviceId) || appliedFilter.value.range !== '7d')
const trend = computed(() => buildTrendBars(snapshot.value?.timeline ?? [], trendMetric.value))
const inspectedBar = computed(() => trend.value.bars.find((bar) => bar.key === selectedBarKey.value)
  ?? [...trend.value.bars].reverse().find((bar) => bar.totals.requestCount > 0))
const trendScaleLabel = computed(() => appliedFilter.value.range === 'today' ? t('translationStats.trend.hourly') : t('translationStats.trend.daily'))
const trendMaximumLabel = computed(() => trendMetric.value === 'latency'
  ? formatDuration(trend.value.maximum)
  : trendMetric.value === 'chars'
    ? t('translationStats.charsValue', {value: formatCompact(trend.value.maximum)})
    : t('translationStats.trend.requests', {count: formatNumber(trend.value.maximum)}))
const visibleBreakdown = computed(() => {
  const rows = sortBreakdown(snapshot.value?.breakdown ?? [], breakdownSort.value, breakdownDirection.value)
  return showAllBreakdown.value ? rows : rows.slice(0, BREAKDOWN_PREVIEW_COUNT)
})
const visibleRoutes = computed(() => sortRoutes(snapshot.value?.routes ?? [], routeSort.value, routeDirection.value))
const durationRows = computed(() => buildHistogramRows(totals.value.durationHistogram, TRANSLATION_STATS_DURATION_BOUNDS_MS))
const sizeRows = computed(() => buildHistogramRows(totals.value.sizeHistogram, TRANSLATION_STATS_SIZE_BOUNDS_CHARS))
const errorRows = computed(() => buildErrorKindRows(totals.value.errorKinds))
const logRange = computed(() => requestPageRange(logOffset.value, logPageSize.value, logTotal.value))

function serviceLabel(serviceId: string): string {
  const label = options.services.find((option) => option.value === serviceId)?.label
    || getCustomOpenAIProviderLabel(customOpenAIProviders.value, serviceId)
  return label ? translateLegacy(label) : serviceId
}

function formatNumber(value: number): string {
  return formatStatsNumber(value, language.value)
}

function formatCompact(value: number): string {
  return formatStatsCompact(value, language.value)
}

function formatPercent(value: number | null): string {
  return formatStatsPercent(value, language.value)
}

function formatDuration(value: number | null): string {
  return formatStatsDuration(value, language.value)
}

function formatBytes(value: number): string {
  return formatStatsBytes(value, language.value)
}

function formatAverage(value: number | null): string {
  return value === null ? '—' : t('translationStats.charsValue', {value: formatNumber(Math.round(value))})
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(language.value, {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false}).format(timestamp)
}

function formatRequestTime(timestamp: number): string {
  return new Intl.DateTimeFormat(language.value, {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(timestamp)
}

function bucketLabel(row: TranslationStatsHistogramRow, kind: 'duration' | 'size'): string {
  const format = (value: number) => kind === 'duration' ? formatDuration(value) : formatNumber(value)
  // 区间符号在各界面语言中通用，直接由数值拼出，不占用 message key。
  if (row.lower === null) return `< ${format(row.upper!)}`
  if (row.upper === null) return `≥ ${format(row.lower)}`
  return `${format(row.lower)}–${format(row.upper)}`
}

function requestShapeLabel(item: StoredTranslationRequestEvent): string {
  const shape = item.mode === 'image'
    ? t('translationStats.log.image')
    : t('translationStats.log.segments', {count: formatNumber(item.segmentCount)})
  return `${shape} · ${formatBytes(item.sourceBytes)}`
}

function trendBarLabel(bar: TranslationStatsTrendBar): string {
  return [
    bar.label,
    t('translationStats.trend.requests', {count: formatNumber(bar.totals.requestCount)}),
    t('translationStats.trend.latency', {value: formatDuration(bar.totals.averageDurationMs)}),
    t('translationStats.charsValue', {value: formatNumber(bar.totals.sourceChars)}),
  ].join(' · ')
}

function showTrendLabel(index: number): boolean {
  const count = trend.value.bars.length
  if (count <= 8) return true
  const interval = count <= 14 ? 2 : count <= 24 ? 3 : 5
  return index === 0 || index === count - 1 || index % interval === 0
}

function handleTrendKeydown(event: KeyboardEvent, index: number): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const bars = (event.currentTarget as HTMLElement).closest('ol')?.querySelectorAll<HTMLButtonElement>('.stats-trend-bar')
  if (!bars?.length) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? bars.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + bars.length) % bars.length
  bars[next].focus()
}

function handleRangeKeydown(event: KeyboardEvent, index: number): void {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? rangeOptions.length - 1
    : (index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1) + rangeOptions.length) % rangeOptions.length
  range.value = rangeOptions[next]
  void nextTick(() => rangeControl.value?.querySelector<HTMLButtonElement>(`button[data-range-index="${next}"]`)?.focus())
}

function toggleBreakdownSort(column: TranslationStatsBreakdownSortKey): void {
  if (breakdownSort.value === column) {
    breakdownDirection.value = breakdownDirection.value === 'desc' ? 'asc' : 'desc'
    return
  }
  breakdownSort.value = column
  // 耗时越短越好，首次点击按升序展示最快的服务；其余指标默认从高到低。
  breakdownDirection.value = ['average', 'p95', 'max'].includes(column) ? 'asc' : 'desc'
}

function breakdownAriaSort(column: TranslationStatsBreakdownSortKey): 'ascending' | 'descending' | 'none' {
  if (breakdownSort.value !== column) return 'none'
  return breakdownDirection.value === 'asc' ? 'ascending' : 'descending'
}

function routeLabel(route: string): string {
  const provider = FREE_TRANSLATION_PROVIDERS.find((item) => item.id === route)
  return provider ? translateLegacy(provider.label) : route
}

function routeSummary(routes: readonly string[]): string {
  const [first, ...rest] = routes
  // “+N”是各界面语言通用的计数写法，直接拼出，不占用 message key。
  return rest.length ? `${routeLabel(first)} +${formatNumber(rest.length)}` : routeLabel(first)
}

function toggleRouteSort(column: TranslationRouteSortKey): void {
  if (routeSort.value === column) {
    routeDirection.value = routeDirection.value === 'desc' ? 'asc' : 'desc'
    return
  }
  routeSort.value = column
  routeDirection.value = ['average', 'p95', 'max'].includes(column) ? 'asc' : 'desc'
}

function routeAriaSort(column: TranslationRouteSortKey): 'ascending' | 'descending' | 'none' {
  if (routeSort.value !== column) return 'none'
  return routeDirection.value === 'asc' ? 'ascending' : 'descending'
}

function isBreakdownActive(row: TranslationStatsBreakdownItem): boolean {
  return appliedFilter.value.serviceId === row.serviceId
    && (appliedFilter.value.model === undefined || appliedFilter.value.model === row.model)
}

function selectBreakdown(row: TranslationStatsBreakdownItem): void {
  selectedService.value = row.serviceId
  selectedModel.value = row.model ? row.model : ALL_MODELS
  showAllBreakdown.value = false
}

function handleServiceChange(): void {
  selectedModel.value = ALL_MODELS
  showAllBreakdown.value = false
}

function clearFilters(): void {
  selectedService.value = ''
  selectedModel.value = ALL_MODELS
  range.value = '7d'
  logSource.value = ''
  logOutcome.value = ''
  showAllBreakdown.value = false
}

function currentFilter(): TranslationStatsFilter {
  return {
    range: range.value,
    ...(selectedService.value ? {serviceId: selectedService.value} : {}),
    ...(selectedService.value && selectedModel.value !== ALL_MODELS ? {model: selectedModel.value} : {}),
  }
}

async function sendStatsMessage<T>(message: Record<string, unknown>, missingMessage: string): Promise<T> {
  const response = await browser.runtime.sendMessage({type: 'translationStats', ...message}) as StatsResponse<T> | undefined
  if (response?.success !== true || response.data === undefined) throw new Error(response?.error || missingMessage)
  return response.data
}

async function loadSnapshot(): Promise<void> {
  const revision = ++snapshotRevision
  loading.value = true
  errorMessage.value = ''
  try {
    const data = await sendStatsMessage<TranslationStatsSnapshot>({action: 'query', filter: currentFilter()}, t('translationStats.error.noSnapshot'))
    if (revision !== snapshotRevision) return
    snapshot.value = data
    selectedBarKey.value = ''
    if (data.selected.totals.requestCount > 0) void loadRequestPage(0)
    else resetLog()
  } catch (error) {
    if (revision !== snapshotRevision) return
    errorMessage.value = error instanceof Error ? error.message : t('translationStats.error.unknown')
  } finally {
    if (revision === snapshotRevision) loading.value = false
  }
}

function resetLog(): void {
  logRevision += 1
  logItems.value = []
  logTotal.value = 0
  logOffset.value = 0
  logLoading.value = false
  logError.value = ''
}

async function loadRequestPage(offset: number): Promise<void> {
  if (!props.active || !snapshot.value) return
  const revision = ++logRevision
  const target = Math.max(0, offset)
  logLoading.value = true
  logError.value = ''
  try {
    const page = await sendStatsMessage<TranslationStatsRequestPage>({
      action: 'list',
      query: {
        filter: {
          ...appliedFilter.value,
          ...(logSource.value ? {source: logSource.value} : {}),
          ...(logOutcome.value ? {outcome: logOutcome.value} : {}),
        },
        sort: logSort.value,
        offset: target,
        limit: logPageSize.value,
      },
    }, t('translationStats.error.noPage'))
    if (revision !== logRevision) return
    logItems.value = page.items
    logTotal.value = page.totalCount
    logOffset.value = page.offset
  } catch (error) {
    if (revision !== logRevision) return
    logError.value = error instanceof Error ? error.message : t('translationStats.error.unknown')
  } finally {
    if (revision === logRevision) logLoading.value = false
  }
}

function setSettingsBackgroundInert(value: boolean): void {
  const settingsApp = document.querySelector<HTMLElement>('.settings-app')
  if (value) settingsApp?.setAttribute('inert', '')
  else settingsApp?.removeAttribute('inert')
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
  void nextTick(() => resetButton.value?.focus())
}

function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeResetDialog()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = [...(resetDialog.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  if (!focusable.length) {
    event.preventDefault()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

async function resetStats(): Promise<void> {
  if (resetting.value) return
  resetting.value = true
  resetError.value = ''
  try {
    await sendStatsMessage<{cleared: true}>({action: 'reset'}, t('translationStats.reset.failed'))
    resetDialogOpen.value = false
    setSettingsBackgroundInert(false)
    resetMessage.value = t('translationStats.reset.done')
    await loadSnapshot()
    await nextTick()
    resetButton.value?.focus()
  } catch (error) {
    resetError.value = error instanceof Error ? error.message : t('translationStats.reset.failed')
  } finally {
    resetting.value = false
  }
}

watch([selectedService, selectedModel, range], () => {
  if (mounted && props.active) void loadSnapshot()
}, {flush: 'post'})

watch([logSource, logOutcome, logSort, logPageSize], () => {
  if (mounted && props.active && snapshot.value && !loading.value) void loadRequestPage(0)
}, {flush: 'post'})

watch(() => props.active, (active, previous) => {
  if (mounted && active && !previous) void loadSnapshot()
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
  snapshotRevision += 1
  logRevision += 1
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  unsubscribeConfig()
  setSettingsBackgroundInert(false)
})
</script>

<style scoped src="./translation-stats-dashboard.css"></style>
