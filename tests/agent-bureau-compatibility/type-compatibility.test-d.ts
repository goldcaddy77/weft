import type { ToolConfiguration as BureauToolConfiguration } from 'armorer';
import type { ConversationHistory as BureauConversationHistory } from 'conversationalist';
import type {
  JSONValue as BureauJSONValue,
  ToolAction as BureauToolAction,
  ToolCall as BureauToolCall,
  ToolCallInput as BureauToolCallInput,
  ToolError as BureauToolError,
  ToolResult as BureauToolResult,
  ToolResultInput as BureauToolResultInput,
} from 'interoperability';
import type {
  ConversationHistory,
  JSONValue,
  ToolActionShape,
  ToolCall,
  ToolCallInput,
  ToolDefinition,
  ToolDescriptor,
  ToolErrorShape,
  ToolResult,
  ToolResultInput,
} from 'weft';

declare const bureauJsonValue: BureauJSONValue;
declare const bureauToolAction: BureauToolAction;
declare const bureauToolCall: BureauToolCall;
declare const bureauToolCallInput: BureauToolCallInput;
declare const bureauToolError: BureauToolError;
declare const bureauToolResult: BureauToolResult;
declare const bureauToolResultInput: BureauToolResultInput;
declare const bureauConversationHistory: BureauConversationHistory;
declare const bureauToolConfiguration: BureauToolConfiguration;
declare const weftJsonValueInput: JSONValue;
declare const weftToolActionInput: ToolActionShape;
declare const weftToolCallInputValue: ToolCall;
declare const weftToolCallInputInput: ToolCallInput;
declare const weftToolErrorInput: ToolErrorShape;
declare const weftToolResultInputValue: ToolResult;
declare const weftToolResultInputInput: ToolResultInput;

const weftJsonValue: JSONValue = bureauJsonValue;
const weftToolAction: ToolActionShape = bureauToolAction;
const weftToolCall: ToolCall = bureauToolCall;
const weftToolCallInput: ToolCallInput = bureauToolCallInput;
const weftToolError: ToolErrorShape = bureauToolError;
const weftToolResult: ToolResult = bureauToolResult;
const weftToolResultInput: ToolResultInput = bureauToolResultInput;
const weftConversationHistory: ConversationHistory = bureauConversationHistory;
const weftToolDescriptor: ToolDescriptor = bureauToolConfiguration;
const weftToolDefinition: ToolDefinition = bureauToolConfiguration;
const bureauJsonValueOutput: BureauJSONValue = weftJsonValueInput;
const bureauToolActionOutput: BureauToolAction = weftToolActionInput;
const bureauToolCallOutput: BureauToolCall = weftToolCallInputValue;
const bureauToolCallInputOutput: BureauToolCallInput = weftToolCallInputInput;
const bureauToolErrorOutput: BureauToolError = weftToolErrorInput;
const bureauToolResultOutput: BureauToolResult = weftToolResultInputValue;
const bureauToolResultInputOutput: BureauToolResultInput = weftToolResultInputInput;

void weftJsonValue;
void weftToolAction;
void weftToolCall;
void weftToolCallInput;
void weftToolError;
void weftToolResult;
void weftToolResultInput;
void weftConversationHistory;
void weftToolDescriptor;
void weftToolDefinition;
void bureauJsonValueOutput;
void bureauToolActionOutput;
void bureauToolCallOutput;
void bureauToolCallInputOutput;
void bureauToolErrorOutput;
void bureauToolResultOutput;
void bureauToolResultInputOutput;

declare const call: ToolCall;
void call.arguments;
// @ts-expect-error Tool calls use Agent Bureau's `arguments` field, not Weft's old `input` field.
void call.input;

declare const result: ToolResult;
void result.callId;
void result.content;
void result.outcome;
// @ts-expect-error Tool results use `callId`, not Weft's old `toolCallId` field.
void result.toolCallId;
// @ts-expect-error Tool results use `content`, not Weft's old `output` field.
void result.output;

declare const descriptor: ToolDescriptor;
void descriptor.input;
// @ts-expect-error Tool descriptors use `input`, not Weft's old `inputSchema` field.
void descriptor.inputSchema;
