import type { Stream, StreamManager } from '../core/streaming/index.ts';
import type { LlmService } from './llm.service.ts';

// The one place a chat turn becomes a Stream: SSE (routes/chat.routes.ts)
// and the WebSocket gateway (websocket/ChatWebSocketGateway.ts) both call
// this and forward the same Stream's events over their own wire format,
// instead of each re-implementing "run the LLM, chunk the answer, report
// failure." No new streaming concept — this only ever uses the
// pre-existing StreamManager/Stream abstraction (AAI-031), which had no
// HTTP transport wired to it until this story.
export function streamChatResponse(
  streaming: StreamManager,
  llmService: LlmService,
  message: string,
): Stream<string> {
  const stream = streaming.createStream<string>('chat');

  void (async () => {
    try {
      const result = await llmService.generateResponse(message);

      // Real token-by-token streaming would need the LLM SDK call itself
      // to stream — llmService.generateResponse() resolves once with the
      // full answer (see services/llm.service.ts). Chunking by word here
      // still exercises the real transport (multiple ordered chunks, then
      // a completion event) without pretending the underlying call is
      // token-streamed.
      const words = result.answer.split(' ');
      for (const word of words) {
        stream.push(word);
      }
      stream.complete();
    } catch (error) {
      stream.fail(error instanceof Error ? error.message : String(error));
    }
  })();

  return stream;
}
