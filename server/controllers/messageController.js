import axios from "axios"
import OpenAI from "openai"  
import Chat from "../models/Chat.js"
import User from "../models/User.js"
import imagekit from "../config/imageKit.js"
import { GoogleGenAI } from "@google/genai";
import { buildContextWindow } from "../utils/contextManager.js";


const openai = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

const genAI = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY
});

// text-based AI chat message controller

export const textMessageController = async (req, res) => {
    try {
        const userId = req.user._id;

        if (req.user.credits < 1) {
            return res.json({
                success: false,
                message: "You don't have enough credits to use this feature!"
            });
        }

        const { chatId, prompt } = req.body;

        // Validate input
        if (!chatId || !prompt?.trim()) {
            return res.status(400).json({
                success: false,
                message: "Chat ID and prompt are required"
            });
        }

        // Find the chat belonging to this user
        const chat = await Chat.findOne({
            userId,
            _id: chatId
        });

        if (!chat) {
            return res.status(404).json({
                success: false,
                message: "Chat not found"
            });
        }

        // Add the current user message to chat history
        chat.messages.push({
            role: "user",
            content: prompt.trim(),
            timestamp: Date.now(),
            isImage: false
        });

        // Build token-aware conversation history
        const conversationHistory = buildContextWindow(
            chat.messages,
            6000
        );

        // Send conversation history to Gemini
        const { choices } = await openai.chat.completions.create({
            model: "gemini-3.5-flash-lite",
            messages: conversationHistory
        });

        // Prepare AI response
        const reply = {
            role: "assistant",
            content: choices[0].message.content,
            timestamp: Date.now(),
            isImage: false
        };

        // Save AI response
        chat.messages.push(reply);

        await chat.save();

        // Deduct one credit
        await User.updateOne(
            { _id: userId },
            { $inc: { credits: -1 } }
        );

        return res.json({
            success: true,
            reply
        });

    } catch (error) {
        console.error("TEXT MESSAGE ERROR:", error);
        console.error("ERROR STATUS:", error.status || error.response?.status);
        console.error("ERROR RESPONSE:", error.response?.data);
        console.error("ERROR URL:", error.request?.url);

        return res.status(error.status || error.response?.status || 500).json({
            success: false,
            message: error.message
        });
    }
};


// image based message controller



export const imageMessageController = async (req, res) => {
    try {
        const userId = req.user._id;
        const { prompt, chatId, isPublished } = req.body;

        // 1. Validate request
        if (!prompt || !prompt.trim() || !chatId) {
            return res.status(400).json({
                success: false,
                message: "Prompt and chatId are required."
            });
        }

        // 2. Check credits
        if (req.user.credits < 2) {
            return res.status(400).json({
                success: false,
                message: "You don't have enough credits to use this feature!"
            });
        }

        // 3. Verify chat ownership
        const chat = await Chat.findOne({
            userId,
            _id: chatId
        });

        if (!chat) {
            return res.status(404).json({
                success: false,
                message: "Chat not found."
            });
        }

        // 4. Check environment variables
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("GEMINI_API_KEY is missing.");
        }

        if (
            !process.env.IMAGEKIT_PUBLIC_KEY ||
            !process.env.IMAGEKIT_PRIVATE_KEY ||
            !process.env.IMAGEKIT_URL_ENDPOINT
        ) {
            throw new Error("ImageKit environment variables are missing.");
        }

        // 5. Generate image using Gemini
        console.log("Generating image using Gemini...");

        const response = await genAI.models.generateContent({
            model: "gemini-3.1-flash-image",
            contents: prompt.trim(),
            config: {
                responseModalities: ["TEXT", "IMAGE"]
            }
        });

        // 6. Extract generated image data
        const parts = response.candidates
            ?.flatMap(candidate => candidate.content?.parts ?? []) ?? [];

        const imagePart = parts.find(
            part => part.inlineData?.data
        );

        if (!imagePart) {
            const textResponse = parts
                .filter(part => part.text)
                .map(part => part.text)
                .join("\n");

            console.error(
                "Gemini did not return image data:",
                textResponse
            );

            throw new Error(
                textResponse ||
                "Gemini did not return an image. Check model access and API limits."
            );
        }

        const imageBuffer = Buffer.from(
            imagePart.inlineData.data,
            "base64"
        );

        if (!imageBuffer.length) {
            throw new Error("Gemini returned an empty image.");
        }

        const mimeType =
            imagePart.inlineData.mimeType || "image/png";

        const extension =
            mimeType === "image/jpeg" ? "jpg" :
            mimeType === "image/webp" ? "webp" : "png";

        console.log(
            "Gemini image generated:",
            imageBuffer.length,
            "bytes"
        );

        // 7. Upload generated image to ImageKit
        console.log("Uploading image to ImageKit...");

        const uploadResponse = await imagekit.files.upload({
            file: imageBuffer,
            fileName: `generated-${Date.now()}.${extension}`,
            folder: "/merngpt",
            useUniqueFileName: true
        });

        if (!uploadResponse?.url) {
            throw new Error(
                "ImageKit upload failed to return an image URL."
            );
        }

        console.log("Image uploaded:", uploadResponse.url);

        // 8. Prepare chat messages
        const userMessage = {
            role: "user",
            content: prompt.trim(),
            timestamp: Date.now(),
            isImage: true
        };

        const reply = {
            role: "assistant",
            content: uploadResponse.url,
            timestamp: Date.now(),
            isImage: true,
            isPublished: Boolean(isPublished)
        };

        // 9. Deduct credits atomically
        const updatedUser = await User.findOneAndUpdate(
            {
                _id: userId,
                credits: { $gte: 2 }
            },
            {
                $inc: { credits: -2 }
            },
            {
                new: true
            }
        );

        if (!updatedUser) {
            return res.status(400).json({
                success: false,
                message: "You don't have enough credits to use this feature!"
            });
        }

        // 10. Save messages in MongoDB
        try {
            chat.messages.push(userMessage, reply);
            await chat.save();
        } catch (saveError) {
            // Refund credits if saving the chat fails
            await User.updateOne(
                { _id: userId },
                { $inc: { credits: 2 } }
            );

            throw saveError;
        }

        // 11. Return response to frontend
        return res.status(200).json({
            success: true,
            reply,
            credits: updatedUser.credits
        });

    } catch (error) {
        console.error(
            "IMAGE GENERATION ERROR:",
            error.message
        );

        if (error.status) {
            console.error("API STATUS:", error.status);
        }

        if (error.response?.status) {
            console.error("HTTP STATUS:", error.response.status);
        }

        if (error.response?.data) {
            console.error("API ERROR RESPONSE:", error.response.data);
        }

        return res.status(
            error.status || error.response?.status || 500
        ).json({
            success: false,
            message: error.message || "Image generation failed."
        });
    }
};




// for deleteing the image from community 
export const deleteImage = async (req, res) => {
    try {
        const userId = req.user._id;
        const { chatId, messageId } = req.body;

        const chat = await Chat.findOne({ _id: chatId, userId });
        if (!chat) return res.json({ success: false, message: 'Chat not found' });

        const message = chat.messages.id(messageId);
        if (!message) return res.json({ success: false, message: 'Message not found' });

        message.isPublished = false;
        await chat.save();

        res.json({ success: true, message: 'Image removed from community' });
    } catch (error) {
        res.json({ success: false, message: error.message });
    }
}
