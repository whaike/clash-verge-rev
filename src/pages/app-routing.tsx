import {
  AddRounded,
  DeleteOutlineRounded,
  ExpandMoreRounded,
  PauseCircleOutlineRounded,
  PlayCircleOutlineRounded,
  RouteRounded,
  WarningAmberRounded,
} from '@mui/icons-material'
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  Chip,
  IconButton,
  Input,
  MenuItem,
  Select,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import { useLockFn } from 'ahooks'
import { useCallback, useMemo, useState } from 'react'

import { BasePage, BaseSearchBox, type SearchState } from '@/components/base'
import { useConnectionData } from '@/hooks/use-connection-data'
import { useVerge } from '@/hooks/use-verge'
import {
  useAppRefreshers,
  useClashConfigData,
  useProxiesData,
  useSystemData,
} from '@/providers/app-data-context'
import { findRunningProcesses, patchClashMode } from '@/services/cmds'
import { showNotice } from '@/services/notice-service'

type NormalizedRouting = Required<Omit<IAppRoutingConfig, 'restore'>> &
  Pick<IAppRoutingConfig, 'restore'>

const DEFAULT_ROUTING: NormalizedRouting = {
  enabled: false,
  process_mode: 'always',
  smart_rules_enabled: false,
  smart_proxy_policy: '',
  smart_direct_policy: 'DIRECT',
  smart_reject_ads: true,
  rules: [],
}

const MATCHER_OPTIONS: Array<{
  value: IAppRoutingMatcher
  label: string
}> = [
  { value: 'process-name', label: '进程名' },
  { value: 'process-path', label: '进程路径' },
  { value: 'process-name-regex', label: '进程名正则' },
  { value: 'process-path-regex', label: '路径正则' },
]

const BUILTIN_POLICIES = ['DIRECT', 'REJECT', 'PASS']

const EDGE_PRESET_VALUES =
  OS_PLATFORM === 'darwin'
    ? ['Microsoft Edge Helper', 'Microsoft Edge']
    : OS_PLATFORM === 'win32'
      ? ['msedge.exe']
      : ['msedge', 'microsoft-edge']

const CHROME_PRESET_VALUES =
  OS_PLATFORM === 'darwin'
    ? ['Google Chrome Helper', 'Google Chrome']
    : OS_PLATFORM === 'win32'
      ? ['chrome.exe']
      : ['google-chrome', 'chrome', 'chromium']

const SIGNAL_PRESET_VALUES =
  OS_PLATFORM === 'darwin'
    ? ['Signal Helper (Renderer)', 'Signal Helper', 'Signal']
    : OS_PLATFORM === 'win32'
      ? ['Signal.exe']
      : ['signal-desktop', 'Signal']

type AnalysisCandidate = {
  name: string
  value: string
  path: string
  matcher: IAppRoutingMatcher
  source: '运行中' | '最近连接' | '预设补全'
}

const appBundleRoot = (path: string) =>
  path.match(/^(.*?\/[^/]+\.app)(?:\/|$)/)?.[1] ?? ''

const matchingPresetValues = (query: string) => {
  const normalized = query.trim().toLowerCase()
  if (normalized.includes('signal')) return SIGNAL_PRESET_VALUES
  if (normalized.includes('edge')) return EDGE_PRESET_VALUES
  if (normalized.includes('chrome') || normalized.includes('chromium')) {
    return CHROME_PRESET_VALUES
  }
  return []
}

const isBrowserQuery = (query: string) =>
  /arc|brave|browser|chrome|chromium|edge|firefox|opera|orion|safari|vivaldi|zen/i.test(
    query,
  )

const uid = () =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

const normalizeRouting = (routing?: IAppRoutingConfig): NormalizedRouting => ({
  ...DEFAULT_ROUTING,
  ...routing,
  rules: routing?.rules ?? [],
})

const unique = (values: string[]) => [...new Set(values.filter(Boolean))]

const policyLabel = (policy: string) => {
  if (policy === 'DIRECT') return '直连'
  if (policy === 'REJECT') return '拒绝'
  if (policy === 'PASS') return '继续匹配'
  return policy
}

const matcherRuleType = (matcher: IAppRoutingMatcher) => {
  if (matcher === 'process-path') return 'PROCESS-PATH'
  if (matcher === 'process-name-regex') return 'PROCESS-NAME-REGEX'
  if (matcher === 'process-path-regex') return 'PROCESS-PATH-REGEX'
  return 'PROCESS-NAME'
}

const prepareRule = (
  rule: Omit<IAppRoutingRule, 'uid'>,
): IAppRoutingRule | null => {
  const value = rule.value.trim()
  const policy = rule.policy.trim()
  if (!value || !policy) return null

  return {
    uid: uid(),
    enabled: true,
    ...rule,
    name: rule.name?.trim() || value,
    value,
    policy,
  }
}

const ruleKey = (rule: Pick<IAppRoutingRule, 'matcher' | 'value'>) =>
  `${rule.matcher}\n${rule.value.trim()}`

const replaceMatchingRules = (
  currentRules: IAppRoutingRule[],
  nextRules: IAppRoutingRule[],
) => {
  const keys = new Set(nextRules.map(ruleKey))
  return currentRules.filter((rule) => !keys.has(ruleKey(rule)))
}

const previewRule = (rule: IAppRoutingRule) => {
  if (rule.enabled === false) return null

  const value = rule.value.trim()
  const policy = rule.policy.trim()
  if (!value || !policy) return null

  return `${matcherRuleType(rule.matcher)},${value},${policy}`
}

const addressRulesPreview = (rule: IAppRoutingRule) => {
  if (rule.enabled === false || rule.address_policy !== 'cn-direct') return []
  const value = rule.value.trim()
  if (!value) return []
  const matcher = matcherRuleType(rule.matcher)
  return [
    `AND,((${matcher},${value}),(GEOSITE,cn)),DIRECT`,
    `AND,((${matcher},${value}),(GEOIP,CN)),DIRECT`,
  ]
}

const smartRulesPreview = (routing: NormalizedRouting) => {
  if (!routing.smart_rules_enabled) return []

  const proxyPolicy = routing.smart_proxy_policy.trim()
  const directPolicy = routing.smart_direct_policy.trim() || 'DIRECT'
  const rules: string[] = []

  if (routing.smart_reject_ads) {
    rules.push('GEOSITE,category-ads-all,REJECT')
  }

  rules.push(`GEOIP,private,${directPolicy},no-resolve`)
  rules.push(`GEOSITE,cn,${directPolicy}`)
  rules.push(`GEOIP,CN,${directPolicy},no-resolve`)

  if (proxyPolicy) {
    rules.push(`GEOSITE,geolocation-!cn,${proxyPolicy}`)
  }

  return rules
}

const AppRoutingPage = () => {
  const { verge, mutateVerge, patchVerge } = useVerge()
  const { proxyView } = useProxiesData()
  const { clashConfig } = useClashConfigData()
  const { refreshClashConfig, refreshSysproxy } = useAppRefreshers()
  const { runningMode, systemProxyAddress, sysproxy } = useSystemData()
  const {
    response: { data: connections },
  } = useConnectionData()

  const routing = normalizeRouting(verge?.app_routing)
  const [draftName, setDraftName] = useState('')
  const [draftMatcher, setDraftMatcher] =
    useState<IAppRoutingMatcher>('process-name')
  const [draftValue, setDraftValue] = useState('')
  const [draftPolicy, setDraftPolicy] = useState('DIRECT')
  const [appQuery, setAppQuery] = useState('')
  const [analysisCandidates, setAnalysisCandidates] = useState<
    AnalysisCandidate[]
  >([])
  const [analysisMessage, setAnalysisMessage] = useState('')
  const [match, setMatch] = useState<(input: string) => boolean>(
    () => () => true,
  )
  const [hasSearch, setHasSearch] = useState(false)

  const proxyPolicies = useMemo(() => {
    const groups = proxyView
      ? unique([
          proxyView.global?.name ?? '',
          ...proxyView.groups.map((group) => group.name),
        ])
      : []
    return unique([...BUILTIN_POLICIES, ...groups])
  }, [proxyView])

  const defaultProxyPolicy = useMemo(
    () =>
      proxyView?.groups.find(
        (group) =>
          !BUILTIN_POLICIES.includes(group.name) && group.name !== 'GLOBAL',
      )?.name ??
      proxyView?.global?.name ??
      'DIRECT',
    [proxyView],
  )
  const defaultProxyGroup = useMemo(
    () =>
      proxyView?.global?.name === defaultProxyPolicy
        ? proxyView.global
        : proxyView?.groups.find((group) => group.name === defaultProxyPolicy),
    [defaultProxyPolicy, proxyView],
  )
  const defaultProxyIsDirect = defaultProxyGroup?.now === 'DIRECT'
  const effectiveSmartProxyPolicy =
    routing.smart_proxy_policy || defaultProxyPolicy

  const processCandidates = useMemo(() => {
    const rows = [
      ...(connections?.activeConnections ?? []),
      ...(connections?.closedConnections ?? []),
    ]
    const byKey = new Map<string, { process: string; processPath: string }>()
    for (const row of rows) {
      const process = row.metadata.process || ''
      const processPath = row.metadata.processPath || ''
      if (!process && !processPath) continue
      const key = `${process}\n${processPath}`
      if (!byKey.has(key)) byKey.set(key, { process, processPath })
    }
    return [...byKey.values()].slice(0, 12)
  }, [connections])

  const analyzeApplication = useLockFn(async () => {
    const query = appQuery.trim()
    if (!query) {
      setAnalysisMessage('请输入正在运行的应用名称')
      setAnalysisCandidates([])
      return
    }

    try {
      const running = await findRunningProcesses(query)
      const queryLower = query.toLowerCase()
      const bundleRoots = unique(
        running
          .map((process) => appBundleRoot(process.path))
          .filter(
            (root) =>
              root && root.split('/').pop()?.toLowerCase().includes(queryLower),
          ),
      )
      // A generic executable term such as "Chrome" can occur in extension
      // hosts and helper binaries owned by other applications. When a matching
      // application bundle is running, only keep its descendants.
      const relevantRunning = bundleRoots.length
        ? running.filter((process) =>
            bundleRoots.some((root) => process.path.startsWith(root)),
          )
        : running
      const candidates: AnalysisCandidate[] = [
        ...relevantRunning.map((process) => ({
          name: process.name,
          value: process.path || process.name,
          path: process.path,
          matcher: process.path
            ? ('process-path' as const)
            : ('process-name' as const),
          source: '运行中' as const,
        })),
        ...processCandidates
          .filter(
            (process) =>
              process.process.toLowerCase().includes(queryLower) ||
              process.processPath.toLowerCase().includes(queryLower),
          )
          .map((process) => ({
            name: process.process || process.processPath,
            value: process.processPath || process.process,
            path: process.processPath,
            matcher: process.processPath
              ? ('process-path' as const)
              : ('process-name' as const),
            source: '最近连接' as const,
          })),
        ...matchingPresetValues(query).map((value) => ({
          name: value,
          value,
          path: '',
          matcher: 'process-name' as const,
          source: '预设补全' as const,
        })),
      ]
      const candidateByValue = new Map<string, AnalysisCandidate>()
      for (const candidate of candidates) {
        const key = candidate.name.toLowerCase()
        // Running processes are collected first and are stronger evidence than
        // a connection snapshot or a platform preset. A name observed from a
        // concrete executable path must not be weakened by a broad preset.
        if (candidate.name && !candidateByValue.has(key)) {
          candidateByValue.set(key, candidate)
        }
      }
      const uniqueCandidates = [...candidateByValue.values()]
      setAnalysisCandidates(uniqueCandidates)
      setAnalysisMessage(
        uniqueCandidates.length
          ? `已识别 ${uniqueCandidates.length} 个需要覆盖的进程（优先精确路径）`
          : '未找到运行进程。请先打开应用并产生一次网络连接后再检查。',
      )
    } catch (error) {
      setAnalysisCandidates([])
      setAnalysisMessage(`检查失败：${String(error)}`)
    }
  })

  const displayedRules = useMemo(() => {
    if (!hasSearch) return routing.rules
    return routing.rules.filter((rule) =>
      [rule.name, rule.value, rule.policy, rule.source].some((value) =>
        match(value ?? ''),
      ),
    )
  }, [hasSearch, match, routing.rules])

  const generatedRules = useMemo(() => {
    const rules: string[] = []
    for (const rule of routing.rules) {
      rules.push(...addressRulesPreview(rule))
    }
    for (const rule of routing.rules) {
      const line = previewRule(rule)
      if (line) rules.push(line)
    }
    rules.push(
      ...smartRulesPreview({
        ...routing,
        smart_proxy_policy: effectiveSmartProxyPolicy,
      }),
    )
    rules.push('MATCH,DIRECT')
    return rules
  }, [effectiveSmartProxyPolicy, routing])

  const saveRouting = useCallback(
    async (next: IAppRoutingConfig) => {
      // TUN already captures every process. Leaving the macOS system proxy on
      // would make unselected applications take an unnecessary loopback hop.
      const clearSystemProxy = Boolean(next.enabled && verge?.enable_tun_mode)
      mutateVerge((current) =>
        current
          ? {
              ...current,
              app_routing: next,
              ...(clearSystemProxy ? { enable_system_proxy: false } : {}),
            }
          : current,
      )
      await patchVerge({
        app_routing: next,
        ...(clearSystemProxy ? { enable_system_proxy: false } : {}),
      })
    },
    [mutateVerge, patchVerge, verge?.enable_tun_mode],
  )

  const patchRouting = useCallback(
    (patch: Partial<IAppRoutingConfig>) =>
      saveRouting({
        ...routing,
        ...patch,
      }),
    [routing, saveRouting],
  )

  const currentMode = clashConfig?.mode?.toLowerCase?.() ?? ''
  const isRuleMode = currentMode === 'rule'

  const enableSelectedAppsOnly = useLockFn(
    async (nextRules: IAppRoutingRule[] = routing.rules) => {
      const hasSelectedApp = nextRules.some(
        (rule) =>
          rule.enabled !== false &&
          Boolean(rule.value.trim()) &&
          Boolean(rule.policy.trim()),
      )
      if (!hasSelectedApp) {
        showNotice.error('请先检查并添加至少一个应用')
        return
      }
      if (defaultProxyIsDirect) {
        showNotice.error('请先在代理页为出口组选择可用节点')
        return
      }

      const restore =
        routing.enabled && routing.restore
          ? routing.restore
          : {
              clash_mode: currentMode || 'rule',
              enable_tun_mode: Boolean(verge?.enable_tun_mode),
              enable_system_proxy: Boolean(
                verge?.enable_system_proxy ?? sysproxy?.enable,
              ),
            }
      const nextRouting: IAppRoutingConfig = {
        ...routing,
        enabled: true,
        restore,
        process_mode: routing.process_mode || 'always',
        rules: nextRules,
      }

      try {
        // TUN captures every process; selected rules are the exceptions and the
        // generated terminal MATCH keeps everything else off the VPN.
        await patchClashMode('rule')
        await patchVerge({
          enable_tun_mode: true,
          enable_system_proxy: false,
          app_routing: nextRouting,
        })
        mutateVerge((current) =>
          current
            ? {
                ...current,
                enable_tun_mode: true,
                enable_system_proxy: false,
                app_routing: nextRouting,
              }
            : current,
        )
        await Promise.all([refreshClashConfig(), refreshSysproxy()])
        showNotice.success('已启用：仅已添加的应用可按规则使用代理', 1800)
      } catch (error) {
        showNotice.error(error)
      }
    },
  )

  const disableSelectedAppsOnly = useLockFn(async () => {
    const restore = routing.restore
    const nextRouting: IAppRoutingConfig = {
      ...routing,
      enabled: false,
      restore: undefined,
    }

    try {
      await patchVerge({
        app_routing: nextRouting,
        ...(restore
          ? {
              enable_tun_mode: Boolean(restore.enable_tun_mode),
              enable_system_proxy: Boolean(restore.enable_system_proxy),
            }
          : {}),
      })
      mutateVerge((current) =>
        current
          ? {
              ...current,
              app_routing: nextRouting,
              ...(restore
                ? {
                    enable_tun_mode: Boolean(restore.enable_tun_mode),
                    enable_system_proxy: Boolean(restore.enable_system_proxy),
                  }
                : {}),
            }
          : current,
      )
      if (restore?.clash_mode && restore.clash_mode !== currentMode) {
        await patchClashMode(restore.clash_mode)
      }
      await Promise.all([refreshClashConfig(), refreshSysproxy()])
      showNotice.success(
        restore
          ? '已关闭应用分流，并恢复启用前的 Clash 状态'
          : '已关闭应用分流',
        1800,
      )
    } catch (error) {
      showNotice.error(error)
    }
  })

  const addRule = useCallback(
    async (rule: Omit<IAppRoutingRule, 'uid'>) => {
      const nextRule = prepareRule(rule)
      if (!nextRule) return

      const nextRules = [
        nextRule,
        ...replaceMatchingRules(routing.rules, [nextRule]),
      ]

      await enableSelectedAppsOnly(nextRules)
      showNotice.success('已添加应用分流规则', 1200)
    },
    [enableSelectedAppsOnly, routing],
  )

  const addRules = useCallback(
    async (
      rules: Array<Omit<IAppRoutingRule, 'uid'>>,
      replaceAutomaticNames: string[] = [],
    ) => {
      const nextItems: IAppRoutingRule[] = []
      for (const rule of rules) {
        const nextRule = prepareRule(rule)
        if (nextRule) nextItems.push(nextRule)
      }

      if (!nextItems.length) return

      const automaticNames = new Set(
        replaceAutomaticNames.map((name) => name.trim().toLowerCase()),
      )
      const existingRules = replaceMatchingRules(
        routing.rules,
        nextItems,
      ).filter(
        (rule) =>
          rule.source === 'manual' ||
          !automaticNames.has((rule.name ?? '').trim().toLowerCase()),
      )
      await enableSelectedAppsOnly([...nextItems, ...existingRules])
      showNotice.success('已添加应用分流规则', 1200)
    },
    [enableSelectedAppsOnly, routing],
  )

  const addAnalyzedApplication = useCallback(async () => {
    if (!analysisCandidates.length) return
    const name = appQuery.trim()
    await addRules(
      analysisCandidates.map((candidate) => ({
        name: name || candidate.name,
        matcher: candidate.matcher,
        value: candidate.value,
        policy: defaultProxyPolicy,
        address_policy: isBrowserQuery(
          `${name} ${candidate.name} ${candidate.path}`,
        )
          ? 'cn-direct'
          : 'all-proxy',
        source: 'analyzer',
      })),
      name ? [name] : [],
    )
    setAnalysisMessage('已添加并立即应用，无需重启目标应用')
  }, [addRules, analysisCandidates, appQuery, defaultProxyPolicy])

  const onAddDraft = useCallback(async () => {
    await addRule({
      name: draftName,
      matcher: draftMatcher,
      value: draftValue,
      policy: draftPolicy,
      source: 'manual',
    })
    setDraftName('')
    setDraftValue('')
  }, [addRule, draftMatcher, draftName, draftPolicy, draftValue])

  const updateRule = useCallback(
    async (ruleUid: string, patch: Partial<IAppRoutingRule>) => {
      await saveRouting({
        ...routing,
        rules: routing.rules.map((rule) =>
          rule.uid === ruleUid ? { ...rule, ...patch } : rule,
        ),
      })
    },
    [routing, saveRouting],
  )

  const deleteRule = useCallback(
    async (ruleUid: string) => {
      await saveRouting({
        ...routing,
        rules: routing.rules.filter((rule) => rule.uid !== ruleUid),
      })
    },
    [routing, saveRouting],
  )

  const handleSearch = useCallback(
    (match: (content: string) => boolean, state: SearchState) => {
      setMatch(() => match)
      setHasSearch(state.text.length > 0)
    },
    [],
  )

  const systemProxyEnabled = Boolean(sysproxy?.enable)
  const trafficCaptured = Boolean(verge?.enable_tun_mode || systemProxyEnabled)
  const interceptionState = !routing.enabled
    ? '已暂停'
    : verge?.enable_tun_mode
      ? 'TUN 已接管'
      : systemProxyEnabled
        ? `系统代理已接管 ${systemProxyAddress}`
        : runningMode
          ? `等待流量接管 (${runningMode})`
          : '等待流量接管'
  const switchToRuleMode = useCallback(async () => {
    await patchClashMode('rule')
    await refreshClashConfig()
    showNotice.success('已切换到 Rule 模式', 1200)
  }, [refreshClashConfig])

  return (
    <BasePage
      title="应用分流"
      header={
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Chip
            size="small"
            color={routing.enabled ? 'success' : 'default'}
            label={interceptionState}
          />
          <Chip
            size="small"
            color={isRuleMode ? 'success' : 'warning'}
            label={`Mode ${currentMode || '-'}`}
          />
          <Button
            size="small"
            variant="contained"
            startIcon={
              routing.enabled ? (
                <PauseCircleOutlineRounded />
              ) : (
                <PlayCircleOutlineRounded />
              )
            }
            onClick={() =>
              routing.enabled
                ? disableSelectedAppsOnly()
                : enableSelectedAppsOnly()
            }
          >
            {routing.enabled ? '暂停' : '启用'}
          </Button>
          {!isRuleMode && (
            <Button size="small" variant="outlined" onClick={switchToRuleMode}>
              切到 Rule
            </Button>
          )}
        </Box>
      }
    >
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <Box
          sx={{
            p: 1.5,
            borderRadius: 2,
            bgcolor: 'background.paper',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            alignItems: 'center',
          }}
        >
          <RouteRounded color="primary" />
          <Typography sx={{ fontWeight: 700 }}>仅所选应用</Typography>
          <Chip
            size="small"
            color={routing.enabled ? 'success' : 'default'}
            label={routing.enabled ? '策略已启用' : '策略未启用'}
          />
          <Chip
            size="small"
            color={isRuleMode ? 'success' : 'warning'}
            label={isRuleMode ? 'Rule 模式' : '需 Rule 模式'}
          />
          <Chip
            size="small"
            color={verge?.enable_tun_mode ? 'success' : 'warning'}
            label={verge?.enable_tun_mode ? 'TUN 已开启' : '需开启 TUN'}
          />
          <Chip
            size="small"
            color={systemProxyEnabled ? 'warning' : 'success'}
            label={systemProxyEnabled ? '系统代理已开启' : '系统代理已关闭'}
          />
          <Chip size="small" color="success" label="未选应用默认直连" />
          <Button
            size="small"
            variant="contained"
            disabled={
              defaultProxyIsDirect ||
              !routing.rules.some(
                (rule) =>
                  rule.enabled !== false &&
                  Boolean(rule.value.trim()) &&
                  Boolean(rule.policy.trim()),
              )
            }
            onClick={() => enableSelectedAppsOnly()}
          >
            启用仅所选应用
          </Button>
          {defaultProxyIsDirect && (
            <Typography sx={{ color: 'warning.main', fontSize: 13 }}>
              当前出口组未选节点，请先在代理页选择节点。
            </Typography>
          )}
          <Box sx={{ flexBasis: '100%' }} />
          <Typography sx={{ fontWeight: 700 }}>检查应用</Typography>
          <TextField
            size="small"
            label="应用名称"
            placeholder="例如 Signal、Chrome"
            value={appQuery}
            onChange={(event) => {
              setAppQuery(event.target.value)
              setAnalysisCandidates([])
              setAnalysisMessage('')
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void analyzeApplication()
            }}
            sx={{ width: 220 }}
          />
          <Button size="small" variant="outlined" onClick={analyzeApplication}>
            检查
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!analysisCandidates.length || defaultProxyIsDirect}
            onClick={addAnalyzedApplication}
          >
            一键添加 {analysisCandidates.length || ''}
          </Button>
          {analysisMessage && (
            <Typography
              sx={{
                color: analysisCandidates.length
                  ? 'success.main'
                  : 'text.secondary',
                fontSize: 13,
              }}
            >
              {analysisMessage}
            </Typography>
          )}
          {analysisCandidates.map((candidate) => (
            <Tooltip
              key={`${candidate.matcher}-${candidate.value}`}
              title={candidate.path || candidate.source}
            >
              <Chip
                size="small"
                label={`${candidate.name} · ${candidate.source}`}
              />
            </Tooltip>
          ))}
          <Box sx={{ flexBasis: '100%' }} />
          <Typography sx={{ fontWeight: 700 }}>添加应用规则</Typography>
          <Select
            size="small"
            value={routing.process_mode}
            onChange={(event) =>
              patchRouting({
                process_mode: event.target
                  .value as IAppRoutingConfig['process_mode'],
              })
            }
            sx={{ width: 120 }}
          >
            <MenuItem value="always">进程检测</MenuItem>
            <MenuItem value="strict">严格检测</MenuItem>
            <MenuItem value="off">关闭检测</MenuItem>
          </Select>
          <TextField
            size="small"
            label="名称"
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            sx={{ width: 140 }}
          />
          <Select
            size="small"
            value={draftMatcher}
            onChange={(event) =>
              setDraftMatcher(event.target.value as IAppRoutingMatcher)
            }
            sx={{ width: 130 }}
          >
            {MATCHER_OPTIONS.map((option) => (
              <MenuItem key={option.value} value={option.value}>
                {option.label}
              </MenuItem>
            ))}
          </Select>
          <TextField
            size="small"
            label="进程"
            value={draftValue}
            onChange={(event) => setDraftValue(event.target.value)}
            sx={{ minWidth: 220, flex: 1 }}
          />
          <Select
            size="small"
            value={draftPolicy}
            onChange={(event) => setDraftPolicy(event.target.value)}
            sx={{ width: 160 }}
          >
            {proxyPolicies.map((policy) => (
              <MenuItem key={policy} value={policy}>
                {policyLabel(policy)}
              </MenuItem>
            ))}
          </Select>
          <Button
            variant="contained"
            startIcon={<AddRounded />}
            disabled={!draftValue.trim() || !draftPolicy.trim()}
            onClick={onAddDraft}
          >
            添加
          </Button>
        </Box>

        {!isRuleMode && (
          <Box
            sx={{
              p: 1.25,
              borderRadius: 2,
              bgcolor: 'background.paper',
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              color: 'warning.main',
            }}
          >
            <WarningAmberRounded fontSize="small" />
            <Typography sx={{ fontSize: 13 }}>
              当前不是 Rule 模式，PROCESS 规则不会决定流量去向。测试 App
              分流前请切换到 Rule。
            </Typography>
          </Box>
        )}

        {!routing.enabled && (
          <Box
            sx={{
              p: 1.25,
              borderRadius: 2,
              bgcolor: 'background.paper',
              color: 'text.secondary',
            }}
          >
            <Typography sx={{ fontSize: 13 }}>
              已暂停：已恢复启用分流前的 Clash 模式、TUN 与系统代理设置。
            </Typography>
          </Box>
        )}

        {routing.enabled && !trafficCaptured && (
          <Box
            sx={{
              p: 1.25,
              borderRadius: 2,
              bgcolor: 'background.paper',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 1,
              color: 'warning.main',
            }}
          >
            <WarningAmberRounded fontSize="small" />
            <Typography sx={{ fontSize: 13 }}>
              规则已保存，但当前没有接管流量。使用“启用仅所选应用”会开启 TUN，
              不会开启系统代理。
            </Typography>
            <Button
              size="small"
              variant="contained"
              onClick={() => enableSelectedAppsOnly()}
            >
              启用仅所选应用
            </Button>
          </Box>
        )}

        <Box
          sx={{
            p: 1.5,
            borderRadius: 2,
            bgcolor: 'background.paper',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            alignItems: 'center',
          }}
        >
          <Typography sx={{ fontWeight: 700 }}>常用应用</Typography>
          <Chip size="small" label="Microsoft Edge" />
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              addRules(
                EDGE_PRESET_VALUES.map((value) => ({
                  name: 'Microsoft Edge',
                  matcher: 'process-name',
                  value,
                  policy: defaultProxyPolicy,
                  address_policy: 'cn-direct',
                  source: 'preset',
                })),
              )
            }
          >
            Edge 走代理（国内直连）
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              addRules(
                EDGE_PRESET_VALUES.map((value) => ({
                  name: 'Microsoft Edge',
                  matcher: 'process-name',
                  value,
                  policy: 'DIRECT',
                  address_policy: 'all-proxy',
                  source: 'preset',
                })),
              )
            }
          >
            Edge 直连
          </Button>
          <Chip size="small" label="Google Chrome" />
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              addRules(
                CHROME_PRESET_VALUES.map((value) => ({
                  name: 'Google Chrome',
                  matcher: 'process-name',
                  value,
                  policy: defaultProxyPolicy,
                  address_policy: 'cn-direct',
                  source: 'preset',
                })),
              )
            }
          >
            Chrome 走代理（国内直连）
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              addRules(
                CHROME_PRESET_VALUES.map((value) => ({
                  name: 'Google Chrome',
                  matcher: 'process-name',
                  value,
                  policy: 'DIRECT',
                  address_policy: 'all-proxy',
                  source: 'preset',
                })),
              )
            }
          >
            Chrome 直连
          </Button>
          <Chip size="small" label="Signal" />
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              addRules(
                SIGNAL_PRESET_VALUES.map((value) => ({
                  name: 'Signal',
                  matcher: 'process-name',
                  value,
                  policy: defaultProxyPolicy,
                  address_policy: 'all-proxy',
                  source: 'preset',
                })),
              )
            }
          >
            Signal 走代理
          </Button>
          <Button
            size="small"
            variant="outlined"
            onClick={() =>
              addRules(
                SIGNAL_PRESET_VALUES.map((value) => ({
                  name: 'Signal',
                  matcher: 'process-name',
                  value,
                  policy: 'DIRECT',
                  address_policy: 'all-proxy',
                  source: 'preset',
                })),
              )
            }
          >
            Signal 直连
          </Button>
          {defaultProxyIsDirect && (
            <Typography sx={{ color: 'warning.main', fontSize: 13 }}>
              {defaultProxyPolicy} 当前选中 DIRECT；请先在代理页选择节点。
            </Typography>
          )}
        </Box>

        <Accordion
          disableGutters
          elevation={0}
          sx={{ borderRadius: 2, overflow: 'hidden' }}
        >
          <AccordionSummary expandIcon={<ExpandMoreRounded />}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Typography sx={{ fontWeight: 700 }}>
                高级：全局地址规则
              </Typography>
              <Chip
                size="small"
                color={routing.smart_rules_enabled ? 'warning' : 'default'}
                label={
                  routing.smart_rules_enabled ? '会影响已接管流量' : '默认关闭'
                }
              />
            </Box>
          </AccordionSummary>
          <AccordionDetails
            sx={{
              pt: 0,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 1,
              alignItems: 'center',
            }}
          >
            <Switch
              size="small"
              checked={routing.smart_rules_enabled}
              onChange={(_, checked) =>
                patchRouting({
                  smart_rules_enabled: checked,
                  smart_proxy_policy: effectiveSmartProxyPolicy,
                  smart_direct_policy: routing.smart_direct_policy || 'DIRECT',
                })
              }
            />
            <Chip
              size="small"
              color={routing.smart_rules_enabled ? 'success' : 'default'}
              label={routing.smart_rules_enabled ? '已启用' : '未启用'}
            />
            <Typography color="text.secondary" sx={{ fontSize: 13 }}>
              这是地址优先级，不是应用白名单。开启后会在未选应用的默认直连前生效；通常不需要开启。
            </Typography>
            <Box sx={{ flexBasis: '100%' }} />
            <Typography sx={{ fontSize: 13 }}>代理</Typography>
            <Select
              size="small"
              value={effectiveSmartProxyPolicy}
              onChange={(event) =>
                patchRouting({
                  smart_proxy_policy: event.target.value,
                })
              }
              sx={{ width: 180 }}
            >
              {proxyPolicies.map((policy) => (
                <MenuItem key={policy} value={policy}>
                  {policyLabel(policy)}
                </MenuItem>
              ))}
            </Select>
            <Typography sx={{ fontSize: 13 }}>直连</Typography>
            <Select
              size="small"
              value={routing.smart_direct_policy || 'DIRECT'}
              onChange={(event) =>
                patchRouting({
                  smart_direct_policy: event.target.value,
                })
              }
              sx={{ width: 140 }}
            >
              {proxyPolicies.map((policy) => (
                <MenuItem key={policy} value={policy}>
                  {policyLabel(policy)}
                </MenuItem>
              ))}
            </Select>
            <Typography sx={{ fontSize: 13 }}>广告</Typography>
            <Switch
              size="small"
              checked={routing.smart_reject_ads}
              onChange={(_, checked) =>
                patchRouting({
                  smart_reject_ads: checked,
                })
              }
            />
            <Chip
              size="small"
              label={routing.smart_reject_ads ? 'REJECT' : '跳过'}
            />
          </AccordionDetails>
        </Accordion>

        <Box
          sx={{
            p: 1.5,
            borderRadius: 2,
            bgcolor: 'background.paper',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 1,
            alignItems: 'center',
          }}
        >
          <Typography sx={{ fontWeight: 700 }}>最近进程</Typography>
          <Chip
            size="small"
            color={systemProxyEnabled ? 'warning' : 'success'}
            label={
              systemProxyEnabled
                ? `系统代理已开启 ${systemProxyAddress}`
                : '系统代理已关闭'
            }
          />
          <Chip
            size="small"
            color={verge?.enable_tun_mode ? 'success' : 'warning'}
            label={verge?.enable_tun_mode ? 'TUN 开启' : 'TUN 未开启'}
          />
          <Box sx={{ flexBasis: '100%' }} />
          {processCandidates.length === 0 && (
            <Typography color="text.secondary" sx={{ fontSize: 13 }}>
              打开连接页或让目标 App 产生网络连接后，这里会出现进程。
            </Typography>
          )}
          {processCandidates.map((candidate) => {
            const value = candidate.process || candidate.processPath
            const matcher: IAppRoutingMatcher = candidate.process
              ? 'process-name'
              : 'process-path'
            return (
              <Box
                key={`${candidate.process}-${candidate.processPath}`}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  maxWidth: '100%',
                }}
              >
                <Tooltip title={candidate.processPath || candidate.process}>
                  <Chip
                    size="small"
                    label={candidate.process || candidate.processPath}
                    sx={{ maxWidth: 240 }}
                  />
                </Tooltip>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() =>
                    addRule({
                      name: candidate.process || candidate.processPath,
                      matcher,
                      value,
                      policy: defaultProxyPolicy,
                      source: 'connection',
                    })
                  }
                >
                  走代理
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={() =>
                    addRule({
                      name: candidate.process || candidate.processPath,
                      matcher,
                      value,
                      policy: 'DIRECT',
                      source: 'connection',
                    })
                  }
                >
                  直连
                </Button>
              </Box>
            )
          })}
        </Box>

        <Box
          sx={{
            p: 1.5,
            borderRadius: 2,
            bgcolor: 'background.paper',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <Typography sx={{ fontWeight: 700 }}>注入预览</Typography>
            <Chip
              size="small"
              color={
                routing.enabled && generatedRules.length ? 'success' : 'default'
              }
              label={
                routing.enabled
                  ? `${generatedRules.length} 条可注入规则`
                  : '应用分流已暂停'
              }
            />
          </Box>
          {generatedRules.length === 0 ? (
            <Typography color="text.secondary" sx={{ fontSize: 13 }}>
              启用后，未选中的应用会在订阅规则前命中 MATCH,DIRECT。
            </Typography>
          ) : (
            <Box
              component="pre"
              sx={{
                m: 0,
                p: 1,
                borderRadius: 1,
                bgcolor: 'action.hover',
                color: routing.enabled ? 'text.primary' : 'text.secondary',
                fontFamily: 'monospace',
                fontSize: 12,
                lineHeight: 1.7,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {generatedRules.join('\n')}
            </Box>
          )}
        </Box>

        <Box
          sx={{
            borderRadius: 2,
            bgcolor: 'background.paper',
            overflow: 'hidden',
          }}
        >
          <Box
            sx={{
              p: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 1,
            }}
          >
            <Typography sx={{ fontWeight: 700 }}>
              规则列表 ({routing.rules.length})
            </Typography>
            <BaseSearchBox
              placeholder="搜索应用或策略"
              onSearch={handleSearch}
            />
          </Box>

          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={72}>启用</TableCell>
                <TableCell width={160}>名称</TableCell>
                <TableCell width={140}>匹配</TableCell>
                <TableCell>进程值</TableCell>
                <TableCell width={150}>地址策略</TableCell>
                <TableCell width={170}>策略</TableCell>
                <TableCell width={92} align="right">
                  操作
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {displayedRules.map((rule) => (
                <TableRow key={rule.uid} hover>
                  <TableCell>
                    <Switch
                      size="small"
                      checked={rule.enabled ?? true}
                      onChange={(_, checked) =>
                        updateRule(rule.uid, { enabled: checked })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      disableUnderline
                      value={rule.name ?? ''}
                      onChange={(event) =>
                        updateRule(rule.uid, { name: event.target.value })
                      }
                      sx={{ width: '100%' }}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      size="small"
                      value={rule.matcher}
                      onChange={(event) =>
                        updateRule(rule.uid, {
                          matcher: event.target.value as IAppRoutingMatcher,
                        })
                      }
                      sx={{ width: 130 }}
                    >
                      {MATCHER_OPTIONS.map((option) => (
                        <MenuItem key={option.value} value={option.value}>
                          {option.label}
                        </MenuItem>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Input
                      disableUnderline
                      value={rule.value}
                      onChange={(event) =>
                        updateRule(rule.uid, { value: event.target.value })
                      }
                      sx={{ width: '100%' }}
                    />
                  </TableCell>
                  <TableCell>
                    <Select
                      size="small"
                      value={rule.address_policy ?? 'all-proxy'}
                      onChange={(event) =>
                        updateRule(rule.uid, {
                          address_policy: event.target
                            .value as IAppRoutingRule['address_policy'],
                        })
                      }
                      sx={{ width: 140 }}
                    >
                      <MenuItem value="all-proxy">全部按应用策略</MenuItem>
                      <MenuItem value="cn-direct">国内直连</MenuItem>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Select
                      size="small"
                      value={rule.policy}
                      onChange={(event) =>
                        updateRule(rule.uid, { policy: event.target.value })
                      }
                      sx={{ width: 150 }}
                    >
                      {proxyPolicies.includes(rule.policy) || (
                        <MenuItem value={rule.policy}>{rule.policy}</MenuItem>
                      )}
                      {proxyPolicies.map((policy) => (
                        <MenuItem key={policy} value={policy}>
                          {policyLabel(policy)}
                        </MenuItem>
                      ))}
                    </Select>
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      title="删除"
                      onClick={() => deleteRule(rule.uid)}
                    >
                      <DeleteOutlineRounded fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
              {displayedRules.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Typography
                      color="text.secondary"
                      sx={{ py: 3, textAlign: 'center' }}
                    >
                      暂无应用分流规则
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Box>
      </Box>
    </BasePage>
  )
}

export default AppRoutingPage
