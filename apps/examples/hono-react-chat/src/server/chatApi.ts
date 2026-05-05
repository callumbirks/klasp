import { KlaspError, type KlaspRealtimeAdapter } from "@klasp/core";
import { createKlasp } from "@klasp/server";
import type {
    ChatMessage,
    chatContract,
    ListMessagesInput,
    SendMessageInput,
} from "../shared/chat.js";

const MAX_AUTHOR_LENGTH = 32;
const MAX_TEXT_LENGTH = 500;
const MAX_MESSAGES_PER_ROOM = 100;

let nextMessageId = 1;

const messages: ChatMessage[] = [
    {
        id: "welcome",
        roomId: "general",
        author: "Klasp",
        text: "Open this example in two tabs, send a message, and watch the other tab refresh through SSE invalidation.",
        createdAt: Date.now(),
    },
];

export function createChatApi(realtime?: KlaspRealtimeAdapter) {
    const klasp = realtime ? createKlasp({ realtime }) : createKlasp({});

    const api = klasp.router<typeof chatContract>({
        chat: {
            listMessages: klasp.query({
                input: parseListMessagesInput,
                handler({ input }) {
                    return messages
                        .filter((message) => message.roomId === input.roomId)
                        .slice(-MAX_MESSAGES_PER_ROOM);
                },
                live({ input }) {
                    return {
                        topics: [roomTopic(input.roomId)],
                    };
                },
            }),
            sendMessage: klasp.mutation({
                input: parseSendMessageInput,
                async handler({ input, klasp: runtime }) {
                    const message: ChatMessage = {
                        id: String(nextMessageId++),
                        roomId: input.roomId,
                        author: input.author,
                        text: input.text,
                        createdAt: Date.now(),
                    };

                    messages.push(message);
                    await runtime.invalidate(roomTopic(input.roomId));

                    return message;
                },
            }),
        },
    });

    return {
        klasp,
        api,
    };
}

function roomTopic(roomId: string): string {
    return `chat:room:${roomId}`;
}

function parseListMessagesInput(input: unknown): ListMessagesInput {
    const object = parseObject(input);

    return {
        roomId: parseNonEmptyString(object.roomId, "roomId", 64),
    };
}

function parseSendMessageInput(input: unknown): SendMessageInput {
    const object = parseObject(input);

    return {
        roomId: parseNonEmptyString(object.roomId, "roomId", 64),
        author: parseNonEmptyString(object.author, "author", MAX_AUTHOR_LENGTH),
        text: parseNonEmptyString(object.text, "text", MAX_TEXT_LENGTH),
    };
}

function parseObject(input: unknown): Record<string, unknown> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new KlaspError("VALIDATION_ERROR", "Expected an object input.");
    }

    return input as Record<string, unknown>;
}

function parseNonEmptyString(
    value: unknown,
    fieldName: string,
    maxLength: number,
): string {
    if (typeof value !== "string") {
        throw new KlaspError(
            "VALIDATION_ERROR",
            `Expected '${fieldName}' to be a string.`,
        );
    }

    const trimmed = value.trim();

    if (!trimmed) {
        throw new KlaspError(
            "VALIDATION_ERROR",
            `Expected '${fieldName}' to be non-empty.`,
        );
    }

    if (trimmed.length > maxLength) {
        throw new KlaspError(
            "VALIDATION_ERROR",
            `Expected '${fieldName}' to be at most ${maxLength} characters.`,
        );
    }

    return trimmed;
}
