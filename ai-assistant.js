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

   IMPORTANT: loading a model has two phases — (1) downloading the weights,
   which reports progress normally, and (2) compiling them for the local
   GPU, which WebLLM does NOT report progress for and can take a long time
   on weak or virtualized graphics (e.g. remote desktops / VMs without a
   real GPU). Without special handling, phase 2 looks identical to a
   frozen page. This module explicitly detects that transition, tells the
   person what's happening, and enforces a hard timeout so it can never
   hang forever with no way out.
   ========================================================================== */

const MODEL_F16 = "Llama-3.2-1B-Instruct-q4f16_1-MLC"; // small + fast; needs the WebGPU "shader-f16" feature
const MODEL_F32 = "Llama-3.2-1B-Instruct-q4f32_1-MLC"; // wider-compatibility fallback; larger download, no f16 requirement
const LOAD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — generous, but bounded

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

/**
 * Picks the right model variant for this device: the smaller/faster f16
 * model where the GPU driver supports it, otherwise the larger but far
 * more broadly compatible f32 model. This is decided BEFORE any download
 * starts, so an incompatible device doesn't waste minutes downloading a
 * model it can never actually run.
 */
async function pickModelId() {
  try {
    if (!navigator.gpu) return MODEL_F16;
    const adapter = await navigator.gpu.requestAdapter();
    if (adapter?.features?.has?.("shader-f16")) return MODEL_F16;
    return MODEL_F32;
  } catch {
    return MODEL_F16; // best effort — if detection itself fails, try the normal path first
  }
}

/**
 * Best-effort check for whether WebGPU is backed by real hardware or a slow
 * software/CPU fallback (common in virtual machines and remote desktops).
 * Returns a human-readable warning string, or null if nothing to warn about.
 * Never throws — if the check itself fails, it just skips the warning.
 */
export async function getWebGPUWarning() {
  try {
    if (!isWebGPUSupported()) return null;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return "Your browser reports WebGPU support but couldn't get a graphics adapter — the AI model likely won't load here.";
    const isFallback =
      adapter.isFallbackAdapter === true ||
      (adapter.info && adapter.info.isFallbackAdapter === true);
    if (isFallback) {
      return "This device/browser is only using a software graphics fallback (common on virtual machines and remote desktops), not a real GPU. The AI model may load very slowly or appear to freeze. For best results, try a physical computer with an up-to-date Chrome or Edge.";
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadModel(onProgress) {
  if (engine) return engine;
  const webllm = await import("https://esm.run/@mlc-ai/web-llm");

  const attempt = async (modelId) => {
    const newEngine = new webllm.MLCEngine();
    let sawCompletedDownload = false;
    newEngine.setInitProgressCallback((report) => {
      const text = report.text || "";
      if (!sawCompletedDownload && (report.progress >= 1 || /100%/.test(text))) {
        sawCompletedDownload = true;
      }
      onProgress?.({ text, stage: sawCompletedDownload ? "compiling" : "downloading" });
    });
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("TIMEOUT")), LOAD_TIMEOUT_MS);
    });
    await Promise.race([newEngine.reload(modelId), timeout]);
    return newEngine;
  };

  const preferredModel = await pickModelId();
  try {
    engine = await attempt(preferredModel);
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg === "TIMEOUT") {
      throw new Error("Timed out preparing the AI model on this device. This usually means the browser/device doesn't have real GPU access (common on virtual machines or remote desktops) rather than anything wrong with the app.");
    }
    const looksLikeF16Issue = preferredModel === MODEL_F16 && /f16|shader|WGSL/i.test(msg);
    if (looksLikeF16Issue) {
      // This device claimed f16 support but couldn't actually compile it —
      // fall back automatically to the wider-compatibility model instead
      // of failing outright.
      onProgress?.({ text: "Switching to a compatibility mode for this device's graphics hardware — restarting the download…", stage: "downloading" });
      engine = await attempt(MODEL_F32);
    } else {
      throw e;
    }
  }
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
