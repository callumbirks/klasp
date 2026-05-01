import { createKlaspContract } from "@klasp/core";

export interface ChatMessage {
    id: string;
    roomId: string;
    author: string;
    text: string;
    createdAt: number;
}

export interface ListMessagesInput {
    roomId: string;
}

export interface SendMessageInput {
    roomId: string;
    author: string;
    text: string;
}

const contract = createKlaspContract();

export const chatContract = contract.router({
    chat: {
        listMessages: contract.query<ListMessagesInput, ChatMessage[]>(),
        sendMessage: contract.mutation<SendMessageInput, ChatMessage>(),
    },
});
