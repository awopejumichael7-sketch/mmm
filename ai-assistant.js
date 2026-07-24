/* ==========================================================================
   AI-ASSISTANT.JS — Free, in-browser AI assistant (Teacher Portal)
   --------------------------------------------------------------------------
   Runs the model entirely inside the teacher's own browser tab using
   WebLLM (https://github.com/mlc-ai/web-llm), powered by WebGPU. There is
   no API key, no backend server, and no per-message cost of any kind —
   the only "cost" is a one-time model download the first time it's used on
   a given device (the browser caches it after that). Nothing is sent to
   Anthropic, OpenAI, or any other paid service.

   Requirements: a browser with WebGPU (current Chrome/Edge on desktop or
   a modern Android device). Safari/Firefox and most low-power devices
   don't support WebGPU yet — the UI detects this and explains it plainly
   rather than failing silently.
   ========================================================================== */

const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC"; // small + fast; free & open-weight

let engine = null;
let history = [
  { role: "system", content: "You are a helpful teaching assistant for a Bible college. Help the teacher draft lesson ideas, quiz questions, explanations, and feedback. Be concise and practical." }
];

export function isWebGPUSupported() {
  return typeof navigator !== "undefined" && !!navigator.gpu;
}

export function isModelLoaded() {
  return !!engine;
}

export async function loadModel(onProgress) {
  if (engine) return engine;
  const webllm = await import("https://esm.run/@mlc-ai/web-llm");
  const newEngine = new webllm.MLCEngine();
  newEngine.setInitProgressCallback((report) => onProgress?.(report));
  await newEngine.reload(MODEL_ID);
  engine = newEngine;
  return engine;
}

export function resetConversation() {
  history = [history[0]];
}

export function getHistory() {
  return history.filter(m => m.role !== "system");
}

export async function sendMessage(userText, onToken) {
  if (!engine) throw new Error("Model not loaded yet");
  history.push({ role: "user", content: userText });
  const completion = await engine.chat.completions.create({
    messages: history,
    stream: true,
    temperature: 0.7
  });
  let full = "";
  for await (const chunk of completion) {
    const delta = chunk.choices?.[0]?.delta?.content || "";
    full += delta;
    onToken?.(full);
  }
  history.push({ role: "assistant", content: full });
  return full;
}
