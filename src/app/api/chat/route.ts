import OpenAI from "openai";

export const runtime = "nodejs";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const MOCK =
  "This is a mock reply because OPENAI_API_KEY is not set on the server. " +
  "Set it in your Vercel project or .env.local to get real model outputs. " +
  "In the meantime you can still practice the labeling task: hold left-click on words you dislike and right-click on words you like.";

export async function POST(req: Request) {
  const { messages, model } = (await req.json()) as { messages: Msg[]; model?: string };
  const encoder = new TextEncoder();

  if (!process.env.OPENAI_API_KEY) {
    const stream = new ReadableStream({
      async start(controller) {
        for (const w of MOCK.split(/(?<= )/)) {
          controller.enqueue(encoder.encode(w));
          await new Promise((r) => setTimeout(r, 40));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "X-Mock": "1" } });
  }

  const client = new OpenAI();
  try {
    const completion = await client.chat.completions.create({
      model: model || process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages,
      stream: true,
    });
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of completion) {
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) controller.enqueue(encoder.encode(delta));
          }
        } catch (e) {
          controller.enqueue(encoder.encode(`\n[stream error: ${(e as Error).message}]`));
        }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return new Response((e as Error).message, { status: 500 });
  }
}
