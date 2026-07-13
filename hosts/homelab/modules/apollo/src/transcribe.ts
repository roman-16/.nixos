const TRANSCRIBE_URL = "https://api.mistral.ai/v1/audio/transcriptions";

export interface TranscribeOptions {
  apiKey: string;
  model: string;
}

/**
 * WhatsApp voice notes arrive as OGG/Opus, which the transcription API doesn't
 * list among its supported formats (WAV/MP3/FLAC), so transcode to 16 kHz mono
 * FLAC over pipes (no temp files) before uploading.
 */
async function toFlac(audio: Buffer): Promise<Buffer> {
  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "flac",
      "pipe:1",
    ],
    { stderr: "pipe", stdin: audio, stdout: "pipe" },
  );
  const [flac, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`ffmpeg exited ${exitCode}: ${stderr.trim()}`);
  return Buffer.from(flac);
}

/** Transcribe a WhatsApp voice note with Mistral Voxtral, returning the plain text. */
export async function transcribeAudio(audio: Buffer, options: TranscribeOptions): Promise<string> {
  if (!options.apiKey) throw new Error("MISTRAL_API_KEY is not set");

  const flac = await toFlac(audio);
  const form = new FormData();
  form.append("file", new Blob([flac], { type: "audio/flac" }), "audio.flac");
  form.append("model", options.model);

  const res = await fetch(TRANSCRIBE_URL, {
    body: form,
    headers: { authorization: `Bearer ${options.apiKey}` },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`transcription failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? "").trim();
}
