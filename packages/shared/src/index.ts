export {
  CHAT_PROVIDERS,
  findProvider,
  findModelPricing,
  describeModelRef,
  formatModelRef,
  parseModelRef,
  type ChatModelRef,
  type ChatProvider,
  type ChatProviderId,
  type ModelPricing,
  type ParsedModelRef,
  type ProviderDefinition,
  type ProviderKind,
} from "./models";

export {
  Mode,
  modeSchema,
  toolInputSchemas,
  getToolContracts,
  type ToolContracts,
  type ModeType,
  toolCallArgsSchema,
  messagePartSchema,
  messagePartsSchema,
  chatStreamEventSchema,
  neoLensActivityEventSchema,
  neoLensFileStatusSchema,
  type MessagePart,
  type ChatStreamEvent,
  type NeoLensActivityEvent,
  type NeoLensFileStatus,
} from "./schemas";

export {
  EMPTY_PERMISSION_RULES,
  READ_ONLY_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  addAllowRule,
  addDenyRule,
  bashCommandPrefix,
  classifyBashCommand,
  describeToolCall,
  evaluatePermission,
  isReadOnlyTool,
  isWriteTool,
  needsNoApproval,
  removeRule,
  ruleMatches,
  splitCommandSegments,
  type BashClassification,
  type PermissionDecision,
  type PermissionEvaluation,
  type PermissionRequest,
  type PermissionRules,
  type ToolRisk,
} from "./permissions";

export {
  computeFileDiff,
  formatFileDiff,
  type DiffHunk,
  type DiffLine,
  type DiffLineType,
  type DiffOptions,
  type FileDiff,
} from "./diff";

export {
  COMPACTION_THRESHOLD,
  estimateMessagesTokens,
  estimateTokens,
  formatTokenCount,
  getModelContextWindow,
  measureContext,
  type ContextBudget,
} from "./context";

export {
  buildTypeScriptDependencyGraph,
  assertSafeGraphRoot,
  extractTypeScriptImports,
  resolveImportPath,
  type NeoLensExternalNode,
  type NeoLensFileNode,
  type NeoLensGraph,
  type NeoLensGraphEdge,
} from "./neolens-graph";

export {
  assertSafeWorkspaceRoot,
  buildWorkspaceIndex,
  readWorkspaceFile,
  searchWorkspace,
  type NeoLensFilePreview,
  type NeoLensSearchMatch,
  type NeoLensSearchResult,
  type NeoLensWorkspaceEntry,
  type NeoLensWorkspaceIndex,
} from "./neolens-workspace";

export const NEOLENS_TRACE_SCHEMA_VERSION = 1 as const;
