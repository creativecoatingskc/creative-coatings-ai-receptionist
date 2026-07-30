require("dotenv").config();

const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");

const voiceRoutes = require("./routes/voice");

const app = express();
const server = http.createServer(app);

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TRANSFER_NUMBERS = {
  apparel: "+18164316744",
  sales: "+18167088758",
  design: "+18168010002"
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use("/voice", voiceRoutes);

app.get("/", (req, res) => {
  res.send("Creative Coatings AI Receptionist is running.");
});

const mediaStreamServer = new WebSocket.Server({
  server,
  path: "/media-stream"
});

mediaStreamServer.on("connection", (twilioSocket) => {
  console.log("Twilio media stream connected.");

  let streamSid = null;
  let callSid = null;
  let transferStarted = false;
  let greetingRequested = false;

  const openAiSocket = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1",
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );

  async function transferCall(department) {
    if (transferStarted) {
      return;
    }

    const phoneNumber = TRANSFER_NUMBERS[department];

    if (!phoneNumber || !callSid) {
      throw new Error("Missing transfer number or Twilio Call SID.");
    }

    transferStarted = true;

    const departmentNames = {
      apparel: "Linda and the apparel department",
      sales: "Bryan and the sales team",
      design: "Jen and the design department"
    };

    const response = new twilio.twiml.VoiceResponse();

    response.say(
      { voice: "alice" },
      `Please hold while I connect you with ${departmentNames[department]}.`
    );

    const dial = response.dial({
      answerOnBridge: true,
      timeout: 25
    });

    dial.number(phoneNumber);

    response.say(
      { voice: "alice" },
      "No one was available to answer. Please call back during business hours, and a Creative Coatings team member will be happy to help."
    );

    await twilioClient.calls(callSid).update({
      twiml: response.toString()
    });

    console.log(`Transferred call to ${department}: ${phoneNumber}`);
  }

  function requestOpeningGreeting() {
    if (
      greetingRequested ||
      openAiSocket.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    greetingRequested = true;

    openAiSocket.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions: `
Give this opening greeting exactly once:

"Thank you for calling Creative Coatings. Are you calling about wraps, tint, or signage, apparel, a job status update, or a design question? If you know the name of the employee you're looking for, you can say it now."

After saying the greeting, stop speaking and wait for the caller to answer.
Do not repeat the greeting.
          `.trim()
        }
      })
    );
  }

  openAiSocket.on("open", () => {
    console.log("Connected to OpenAI Realtime.");

    openAiSocket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: "gpt-realtime-2.1",
          output_modalities: ["audio"],

          instructions: `
You are the phone receptionist for Creative Coatings in Platte City, Missouri.

You are friendly, confident, natural, professional, and concise.

IMPORTANT GREETING RULE

The opening greeting is created separately by the phone system.

Never restart or repeat the opening greeting after it has been spoken.

After the opening greeting, wait for the caller to answer and respond directly to what they say.

If there is silence, wait patiently. Do not repeat the full greeting.

If you need to check whether the caller is still there, say only:

"Are you still with me?"

Do not sound like a phone tree.
Do not read long lists.
Allow the caller to answer naturally.
Do not talk over the caller.

CREATIVE COATINGS SERVICES

Creative Coatings provides:

- Commercial vehicle wraps and decals
- Color-change vehicle wraps
- Window tint
- Paint protection film
- Signs, banners, stickers, and decals
- Custom apparel and embroidery
- Graphic design and artwork services

CALL TRANSFER RULES

APPAREL

Transfer to apparel when the caller:

- Asks for Linda
- Asks for the apparel department
- Asks about shirts
- Asks about hats
- Asks about embroidery
- Asks about clothing
- Asks about uniforms
- Asks about custom apparel
- Asks about an existing apparel order

Say:

"I'll connect you with Linda and the apparel department."

Then use the transfer_call tool with department set to apparel.

SALES, WRAPS, TINT, SIGNAGE AND JOB STATUS

Transfer to sales when the caller:

- Asks for Bryan
- Asks for the sales department
- Asks about wraps
- Asks about window tint
- Asks about signage
- Asks about decals
- Asks about banners
- Asks about paint protection film or PPF
- Asks about vehicle services
- Wants a quote
- Wants to discuss pricing
- Wants an update on an existing job
- Asks about job status
- Asks whether their project is finished
- Asks whether their order is ready
- Asks when their project will be completed

Say:

"I'll connect you with Bryan and the sales team."

Then use the transfer_call tool with department set to sales.

DESIGN

Transfer to design when the caller:

- Asks for Jen
- Asks for the design department
- Has an artwork question
- Has a proof question
- Wants a design revision
- Needs help submitting artwork
- Wants to discuss colors, layouts, logos, or design changes

Say:

"I'll connect you with Jen and the design department."

Then use the transfer_call tool with department set to design.

EMPLOYEE NAME ROUTING

If the caller says Linda, transfer to apparel.

If the caller says Bryan, transfer to sales.

If the caller says Jen, transfer to design.

Do not ask unnecessary follow-up questions when the caller has clearly requested a person, service, or department.

Do not tell the caller that you cannot transfer them.

Do not claim that the transfer has succeeded until the transfer tool has been used.

GENERAL CONVERSATION RULES

If the caller is unsure which department they need, ask one short question to determine the correct department.

If the caller wants general information, help them briefly and then offer the appropriate transfer.

If the caller wants a quote but does not want an immediate transfer, collect:

- Their name
- Their phone number
- Vehicle year, make, and model when applicable
- The service they are interested in
- A short description of the project

Do not invent prices.

Do not promise exact completion dates.

Do not say a project is finished unless its status has been verified.

Do not disclose private customer information.

If you do not know an answer, say:

"A Creative Coatings team member will need to confirm that for you."

Then offer the appropriate transfer.
          `.trim(),

          tools: [
            {
              type: "function",
              name: "transfer_call",
              description:
                "Transfer the active caller to the correct Creative Coatings employee or department.",
              parameters: {
                type: "object",
                properties: {
                  department: {
                    type: "string",
                    enum: ["apparel", "sales", "design"],
                    description:
                      "The Creative Coatings department that should receive the call."
                  }
                },
                required: ["department"]
              }
            }
          ],

          tool_choice: "auto",

          audio: {
            input: {
              format: {
                type: "audio/pcmu"
              },
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: true,
                silence_duration_ms: 700
              }
            },

            output: {
              format: {
                type: "audio/pcmu"
              },
              voice: "marin"
            }
          }
        }
      })
    );
  });

  twilioSocket.on("message", (message) => {
    try {
      const event = JSON.parse(message.toString());

      if (event.event === "start") {
        streamSid = event.start.streamSid;
        callSid = event.start.callSid;

        console.log("Twilio stream started:", streamSid);
        console.log("Twilio call SID:", callSid);

        requestOpeningGreeting();
        return;
      }

      if (
        event.event === "media" &&
        openAiSocket.readyState === WebSocket.OPEN
      ) {
        openAiSocket.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: event.media.payload
          })
        );
      }

      if (event.event === "stop") {
        console.log("Twilio stream stopped.");

        if (openAiSocket.readyState === WebSocket.OPEN) {
          openAiSocket.close();
        }
      }
    } catch (error) {
      console.error("Twilio message error:", error.message);
    }
  });

  openAiSocket.on("message", async (message) => {
    try {
      const event = JSON.parse(message.toString());

      if (event.type === "session.updated") {
        requestOpeningGreeting();
      }

      if (
        event.type === "response.output_audio.delta" &&
        event.delta &&
        streamSid &&
        twilioSocket.readyState === WebSocket.OPEN
      ) {
        twilioSocket.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: {
              payload: event.delta
            }
          })
        );
      }

      if (
        event.type === "response.function_call_arguments.done" &&
        event.name === "transfer_call"
      ) {
        const argumentsObject = JSON.parse(event.arguments || "{}");
        const department = argumentsObject.department;

        console.log("Transfer requested:", department);

        try {
          await transferCall(department);
        } catch (error) {
          transferStarted = false;

          console.error("Transfer failed:", error.message);

          if (openAiSocket.readyState === WebSocket.OPEN) {
            openAiSocket.send(
              JSON.stringify({
                type: "conversation.item.create",
                item: {
                  type: "function_call_output",
                  call_id: event.call_id,
                  output: JSON.stringify({
                    success: false,
                    error: "The transfer could not be completed."
                  })
                }
              })
            );

            openAiSocket.send(
              JSON.stringify({
                type: "response.create",
                response: {
                  instructions:
                    "Apologize briefly, explain that the transfer could not be completed, and offer to take a message. Do not repeat the opening greeting."
                }
              })
            );
          }
        }
      }

      if (event.type === "error") {
        console.error("OpenAI Realtime error:", event.error);
      }
    } catch (error) {
      console.error("OpenAI message error:", error.message);
    }
  });

  openAiSocket.on("close", () => {
    console.log("OpenAI Realtime disconnected.");

    if (
      !transferStarted &&
      twilioSocket.readyState === WebSocket.OPEN
    ) {
      twilioSocket.close();
    }
  });

  openAiSocket.on("error", (error) => {
    console.error("OpenAI WebSocket error:", error.message);
  });

  twilioSocket.on("close", () => {
    console.log("Twilio media stream disconnected.");

    if (openAiSocket.readyState === WebSocket.OPEN) {
      openAiSocket.close();
    }
  });

  twilioSocket.on("error", (error) => {
    console.error("Twilio WebSocket error:", error.message);
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});