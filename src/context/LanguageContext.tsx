import React, { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react';

export type Language = 'en' | 'ja' | 'zh';

export const translations = {
  en: {
    appName: "V12 APEX ATLAS",
    commandCenter: "AI Command Center",
    revenueBoardroom: "Revenue Boardroom",
    memoryGalaxy: "Memory Galaxy Vault",
    replHarness: "UI4A REPL Harness",
    synchronizer: "45ms Synchronizer",
    securityAuth: "Security & Auth Shield",
    auditLog: "Decision Audit Log",
    executionDesk: "Asset Ledger",
    status: "STATUS",
    synchronizerLatency: "SYNCHRONIZER",
    guard: "GUARD",
    search: "Search",
    signOut: "Sign Out",
    signIn: "Sign In",
    
    // REPL Harness
    replTitle: "UI4A REPL HARNESS (React 19 GenUI)",
    replDesc: "Interactive GenUI component sandbox with real-time compilation and property injection.",
    promptPlaceholder: "Describe a GenUI component (e.g., 'Real-time telemetry chart with status lights')...",
    compileGenUI: "Compile GenUI",
    resetTemplate: "Reset Code Template",
    copyCode: "Copy Code",
    copied: "Copied!",
    jsxSourceEditor: "JSX Component Source Editor",
    livePreviewHarness: "Live Component Preview Harness",
    injectedProps: "Injected Component Props",

    // Resource Monitor
    resourceMonitorTitle: "SYSTEM RESOURCE MONITOR",
    resourceMonitorDesc: "Illustrative CPU, RAM and GPU load profile for the digital twin environment",
    cpuUsage: "CPU Usage",
    ramUsage: "RAM Usage",
    gpuUsage: "GPU Usage",
    optimal: "OPTIMAL",
    heavyLoad: "HEAVY LOAD",
    liveTelemetryChart: "Live D3 Utilization Stream",

    // Theme & Lang
    sleekTheme: "Sleek Theme",
    highContrastTheme: "High Contrast",
    language: "Language",
    english: "English",
    japanese: "日本語",
    chinese: "中文",
  },
  ja: {
    appName: "V12 APEX ATLAS",
    commandCenter: "AIコマンドセンター",
    revenueBoardroom: "収益役員会",
    memoryGalaxy: "メモリギャラクシー金庫",
    replHarness: "UI4A REPLハーネス",
    synchronizer: "45ms同期モジュール",
    securityAuth: "セキュリティ＆認証シールド",
    auditLog: "意思決定監査ログ",
    executionDesk: "アセット台帳",
    status: "ステータス",
    synchronizerLatency: "同期レイテンシ",
    guard: "セキュリティ監視",
    search: "検索",
    signOut: "サインアウト",
    signIn: "サインイン",
    
    // REPL Harness
    replTitle: "UI4A REPLハーネス (React 19 GenUI)",
    replDesc: "リアルタイムコンパイルとプロパティ注入を備えたインタラクティブGenUIコンポーネントサンドボックス。",
    promptPlaceholder: "GenUIコンポーネントを入力 (例: 'ステータスライト付きリアルタイムテレメトリチャート')...",
    compileGenUI: "GenUIをコンパイル",
    resetTemplate: "コードテンプレートをリセット",
    copyCode: "コードをコピー",
    copied: "コピー完了!",
    jsxSourceEditor: "JSXコンポーネントソースエディタ",
    livePreviewHarness: "ライブコンポーネントプレビューハーネス",
    injectedProps: "注入されたコンポーネントプロパティ",

    // Resource Monitor
    resourceMonitorTitle: "システムリソースモニター",
    resourceMonitorDesc: "デジタルツイン環境のCPU・RAM・GPU負荷の参考プロファイル",
    cpuUsage: "CPU使用率",
    ramUsage: "RAM使用率",
    gpuUsage: "GPU使用率",
    optimal: "正常",
    heavyLoad: "高負荷",
    liveTelemetryChart: "リアルタイムD3使用率ストリーム",

    // Theme & Lang
    sleekTheme: "標準ダーク",
    highContrastTheme: "ハイコントラスト",
    language: "言語",
    english: "English",
    japanese: "日本語",
    chinese: "中文",
  },
  zh: {
    appName: "V12 APEX ATLAS",
    commandCenter: "AI 指挥中心",
    revenueBoardroom: "收益决策控制台",
    memoryGalaxy: "记忆星云金库",
    replHarness: "UI4A REPL 测试环境",
    synchronizer: "45ms 同步模块",
    securityAuth: "安全与身份验证",
    auditLog: "决策审计日志",
    executionDesk: "资产台账",
    status: "运行状态",
    synchronizerLatency: "同步延迟",
    guard: "安全监控",
    search: "搜索",
    signOut: "退出登录",
    signIn: "登录/注册",
    
    // REPL Harness
    replTitle: "UI4A REPL 测试环境 (React 19 GenUI)",
    replDesc: "具有实时编译和属性注入功能的交互式 GenUI 组件沙盒。",
    promptPlaceholder: "描述 GenUI 组件（例如：带状态指示灯的实时遥测图表）...",
    compileGenUI: "编译 GenUI",
    resetTemplate: "重置代码模板",
    copyCode: "复制代码",
    copied: "已复制！",
    jsxSourceEditor: "JSX 组件源码编辑器",
    livePreviewHarness: "组件实时预览测试",
    injectedProps: "注入组件属性",

    // Resource Monitor
    resourceMonitorTitle: "系统资源监控器",
    resourceMonitorDesc: "数字孪生环境的 CPU、RAM 和 GPU 负载示意曲线",
    cpuUsage: "CPU 使用率",
    ramUsage: "RAM 使用率",
    gpuUsage: "GPU 使用率",
    optimal: "最佳状态",
    heavyLoad: "高负载",
    liveTelemetryChart: "实时 D3 占用率数据流",

    // Theme & Lang
    sleekTheme: "标准主题",
    highContrastTheme: "高对比度",
    language: "语言",
    english: "English",
    japanese: "日本語",
    chinese: "中文",
  },
};

export type TranslationKey = keyof typeof translations.en;

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: TranslationKey) => string;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

const STORAGE_KEY = 'v12_language';
const SUPPORTED: Language[] = ['en', 'ja', 'zh'];

export const LanguageProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  // Theme persisted across reloads but language did not, so the workspace
  // silently snapped back to English on every refresh.
  const [language, setLanguageState] = useState<Language>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as Language | null;
      if (stored && SUPPORTED.includes(stored)) return stored;
      const browser = navigator.language?.slice(0, 2) as Language;
      if (SUPPORTED.includes(browser)) return browser;
    } catch {
      /* storage can be blocked; fall through to the default */
    }
    return 'en';
  });

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* non-fatal */
    }
  }, []);

  // Keep the document language in sync so screen readers announce content in
  // the right voice and the browser offers the right translation prompts.
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const t = useCallback(
    (key: TranslationKey): string => translations[language][key] || translations.en[key] || key,
    [language],
  );

  const value = React.useMemo(() => ({ language, setLanguage, t }), [language, setLanguage, t]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
};

export const useLanguage = (): LanguageContextType => {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
};
