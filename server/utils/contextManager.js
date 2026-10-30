
import { encode } from "gpt-tokenizer";

const SYSTEM_PROMPT = {
    role: "system",
    content:
        "You are a helpful AI assistant. Answer using the conversation context when relevant."
};

// Estimates tokens for one chat message.
// The extra 4 tokens approximately account for message formatting overhead.
const estimateMessageTokens = (message) => {
    return encode(message.content || "").length + 4;
};

export const buildContextWindow = (
    messages,
    maxTokenBudget = 6000
) => {
    // Reserve space for the system prompt.
    const systemTokens = estimateMessageTokens(SYSTEM_PROMPT);
    let remainingTokens = maxTokenBudget - systemTokens;

    // Keep only normal text messages with supported roles.
    const validMessages = messages.filter(
        (message) =>
            !message.isImage &&
            ["user", "assistant"].includes(message.role) &&
            typeof message.content === "string"
    );

    const selectedMessages = [];

    // Start from the newest message and move backwards.
    for (let i = validMessages.length - 1; i >= 0; i--) {
        const message = {
            role: validMessages[i].role,
            content: validMessages[i].content
        };

        const messageTokens = estimateMessageTokens(message);

        // Always include the latest message, even if it exceeds
        // the budget. Otherwise, the current prompt could be lost.
        if (
            selectedMessages.length === 0 ||
            messageTokens <= remainingTokens
        ) {
            selectedMessages.push(message);
            remainingTokens -= messageTokens;
        } else {
            // Stop when the next older message does not fit.
            break;
        }
    }

    // We collected messages newest-first; reverse to restore
    // the original conversation order.
    selectedMessages.reverse();

    return [
        SYSTEM_PROMPT,
        ...selectedMessages
    ];
};
