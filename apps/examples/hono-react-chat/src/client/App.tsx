import { useKlaspMutation, useKlaspQuery } from "@klasp/react";
import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { api } from "./klasp.js";

const ROOM_ID = "general";

const timeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
});

export function App() {
    const [author, setAuthor] = useState(() => loadSavedAuthor());
    const [text, setText] = useState("");
    const messages = useKlaspQuery(api.chat.listMessages, { roomId: ROOM_ID });
    const sendMessage = useKlaspMutation(api.chat.sendMessage);
    const canSend = author.trim().length > 0 && text.trim().length > 0;

    const statusText = useMemo(() => {
        if (messages.isLoading && !messages.data) {
            return "Loading messages...";
        }

        if (messages.isError) {
            return messages.error?.message ?? "Unable to load messages.";
        }

        return "Connected through Klasp live query invalidations.";
    }, [messages.data, messages.error, messages.isError, messages.isLoading]);

    async function handleSubmit(event: FormEvent<HTMLFormElement>) {
        event.preventDefault();

        if (!canSend || sendMessage.isLoading) {
            return;
        }

        const trimmedAuthor = author.trim();

        await sendMessage.mutate({
            roomId: ROOM_ID,
            author: trimmedAuthor,
            text: text.trim(),
        });

        window.localStorage.setItem("klasp-chat-author", trimmedAuthor);
        setText("");
    }

    return (
        <main className="shell">
            <section className="hero">
                <p className="eyebrow">Klasp + Hono + React</p>
                <h1>Realtime chat through live query invalidation</h1>
                <p>
                    Open two tabs, send a message, and watch the other tab
                    refetch automatically from the SSE invalidation stream.
                </p>
            </section>

            <section className="chat-card" aria-label="Chat room">
                <header className="chat-header">
                    <div>
                        <h2>#general</h2>
                        <p>{statusText}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => void messages.refetch()}
                    >
                        Refetch
                    </button>
                </header>

                <ol className="messages" aria-live="polite">
                    {(messages.data ?? []).map((message) => (
                        <li className="message" key={message.id}>
                            <div className="message-meta">
                                <strong>{message.author}</strong>
                                <time
                                    dateTime={new Date(
                                        message.createdAt,
                                    ).toISOString()}
                                >
                                    {timeFormatter.format(message.createdAt)}
                                </time>
                            </div>
                            <p>{message.text}</p>
                        </li>
                    ))}
                </ol>

                <form className="composer" onSubmit={handleSubmit}>
                    <label>
                        Display name
                        <input
                            maxLength={32}
                            onChange={(event) => setAuthor(event.target.value)}
                            placeholder="Ada"
                            value={author}
                        />
                    </label>
                    <label>
                        Message
                        <textarea
                            maxLength={500}
                            onChange={(event) => setText(event.target.value)}
                            placeholder="Type a message..."
                            rows={3}
                            value={text}
                        />
                    </label>
                    <div className="composer-actions">
                        {sendMessage.isError ? (
                            <p role="alert">{sendMessage.error?.message}</p>
                        ) : null}
                        <button
                            disabled={!canSend || sendMessage.isLoading}
                            type="submit"
                        >
                            {sendMessage.isLoading
                                ? "Sending..."
                                : "Send message"}
                        </button>
                    </div>
                </form>
            </section>
        </main>
    );
}

function loadSavedAuthor(): string {
    return window.localStorage.getItem("klasp-chat-author") ?? "Klasp User";
}
