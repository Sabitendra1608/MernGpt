import axios from "axios"
import OpenAI from "openai"  
import Chat from "../models/Chat.js"
import User from "../models/User.js"
import imagekit from "../config/imageKit.js"


const openai = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

// text-based AI chat message controller
export const textMessageController = async (req, res) => {
    try {
        const userId = req.user._id
        if(req.user.credits < 1) {
            return res.json({success: false, message: "You don't have enough credits to use this feature!"})
        }
        const {chatId, prompt} = req.body

        const chat = await Chat.findOne({userId, _id: chatId})
        chat.messages.push({role: 'user', content: prompt, timestamp: Date.now(), isImage: false})

        const {choices} = await openai.chat.completions.create({
            model: "gemini-3.5-flash-lite",  
            messages: [{ role: "user", content: prompt }],
        });

        const reply = {...choices[0].message, timestamp: Date.now(), isImage: false} 
        res.json({success: true, reply})
        chat.messages.push(reply);
        await chat.save()

        await User.updateOne({_id: userId}, {$inc : {credits: -1}})
    } catch (error) {
    console.error("TEXT MESSAGE ERROR:", error);
    console.error("ERROR STATUS:", error.status || error.response?.status);
    console.error("ERROR RESPONSE:", error.response?.data);
    console.error("ERROR URL:", error.request?.url);

    res.status(error.status || error.response?.status || 500).json({
        success: false,
        message: error.message
    });
    }
}

// image based message controller

export const imageMessageController = async (req, res) => {
    try {
        const userId = req.user._id;
        const { prompt, chatId, isPublished } = req.body;

        // Check credits
        if (req.user.credits < 2) {
            return res.status(400).json({
                success: false,
                message: "You don't have enough credits to use this feature!"
            });
        }

        if (!prompt || !chatId) {
            return res.status(400).json({
                success: false,
                message: "Prompt and chatId are required."
            });
        }

        // Find chat
        const chat = await Chat.findOne({ userId, _id: chatId });

        if (!chat) {
            return res.status(404).json({
                success: false,
                message: "Chat not found."
            });
        }

        // Generate image using ImageKit URL-based generation
        const encodedPrompt = encodeURIComponent(prompt);
        const endpoint = process.env.IMAGEKIT_URL_ENDPOINT?.replace(/\/$/, "");

        if (!endpoint) {
            throw new Error("IMAGEKIT_URL_ENDPOINT is not configured.");
        }

        const generatedImageUrl =
            `${endpoint}/ik-genimg-prompt-${encodedPrompt}/quickgpt/${Date.now()}.png?tr=w-800,h-800`;

        console.log("Requesting generated image from ImageKit...");

        const imageResponse = await axios.get(generatedImageUrl, {
            responseType: "arraybuffer",
            validateStatus: (status) => status >= 200 && status < 300
        });

        const contentType = imageResponse.headers["content-type"] || "";
        const imageBuffer = Buffer.from(imageResponse.data);

        console.log("Image generation status:", imageResponse.status);
        console.log("Image content type:", contentType);
        console.log("Image size in bytes:", imageBuffer.length);

        // Verify the response is an image
        if (!contentType.startsWith("image/")) {
            const responseText = imageBuffer.toString("utf8").slice(0, 500);
            console.error("ImageKit returned non-image content:", responseText);

            throw new Error(
                `ImageKit did not return an image. Content-Type: ${contentType || "unknown"}`
            );
        }

        if (imageBuffer.length === 0) {
            throw new Error("ImageKit returned an empty image.");
        }

        // Upload binary image to ImageKit storage
        const uploadResponse = await imagekit.files.upload({
            file: imageBuffer,
            fileName: `${Date.now()}.png`,
            folder: "merngpt"
        });

        if (!uploadResponse?.url) {
            throw new Error("ImageKit upload did not return an image URL.");
        }

        console.log("Image uploaded successfully:", uploadResponse.url);

        // Save the user's prompt and generated image
        const userMessage = {
            role: "user",
            content: prompt,
            timestamp: Date.now(),
            isImage: true
        };

        const reply = {
            role: "assistant",
            content: uploadResponse.url,
            timestamp: Date.now(),
            isImage: true,
            isPublished
        };

        chat.messages.push(userMessage, reply);
        await chat.save();

        // Deduct credits after successfully saving the chat
        await User.updateOne(
            { _id: userId },
            { $inc: { credits: -2 } }
        );

        // Return success only after saving
        return res.json({
            success: true,
            reply
        });

    } catch (error) {
        console.error("IMAGE GENERATION ERROR:", error.message);
        console.error("HTTP STATUS:", error.response?.status);
        console.error("RESPONSE CONTENT TYPE:", error.response?.headers?.["content-type"]);

        if (error.response?.data) {
            const data = Buffer.isBuffer(error.response.data)
                ? error.response.data.toString("utf8").slice(0, 500)
                : error.response.data;

            console.error("ERROR RESPONSE:", data);
        }

        return res.status(error.response?.status || 500).json({
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
