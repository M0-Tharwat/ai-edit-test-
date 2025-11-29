
import { GoogleGenAI, Type, Modality } from "@google/genai";

const getAiClient = () => {
  // Try getting key from process.env, fallback to localStorage
  const apiKey = process.env.API_KEY || localStorage.getItem('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error("مفتاح API غير موجود. يرجى إعداده من القائمة.");
  }
  return new GoogleGenAI({ apiKey });
};

// Helper to convert base64 properly
const cleanBase64 = (base64Data: string) => {
  return base64Data.replace(/^data:image\/(png|jpeg|jpg|webp);base64,/, '');
};

const getMimeType = (base64Data: string) => {
  const match = base64Data.match(/^data:(image\/[a-zA-Z+]+);base64,/);
  return match ? match[1] : 'image/png';
};

/**
 * GENERIC: Generates an image from a text prompt.
 */
export const generateImageFromText = async (prompt: string): Promise<string> => {
  const ai = getAiClient();
  const model = 'gemini-2.5-flash-image'; 
  
  const response = await ai.models.generateContent({
    model: model,
    contents: {
      parts: [{ text: prompt }],
    },
    config: {
      imageConfig: {
        aspectRatio: "1:1",
      }
    }
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  
  throw new Error("لم يتم توليد الصورة.");
};

/**
 * HELPER: Generic image-to-image editor
 */
const runImageTask = async (imageBase64: string, prompt: string, model = 'gemini-2.5-flash-image'): Promise<string> => {
  const ai = getAiClient();
  const cleanData = cleanBase64(imageBase64);
  const mimeType = getMimeType(imageBase64);

  const response = await ai.models.generateContent({
    model: model,
    contents: {
      parts: [
        {
          inlineData: {
            data: cleanData,
            mimeType: mimeType,
          },
        },
        {
          text: prompt + " (Return only the modified image)",
        },
      ],
    },
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  throw new Error("فشلت عملية معالجة الصورة.");
}

export const removeBackground = async (imageBase64: string): Promise<string> => {
  return runImageTask(imageBase64, "Remove the background completely. Isolate the main subject on a pure solid white background.");
};

export const removeObject = async (imageBase64: string, objectDescription: string): Promise<string> => {
  return runImageTask(imageBase64, `Remove the ${objectDescription} from the image. Fill in the empty space naturally.`);
};

export const replaceBackground = async (imageBase64: string, bgDescription: string): Promise<string> => {
  return runImageTask(imageBase64, `Change the background to: ${bgDescription}. Ensure realistic lighting.`);
};

export const upscaleImage = async (imageBase64: string): Promise<string> => {
  return runImageTask(imageBase64, "Enhance image quality, resolution, and details.", 'gemini-3-pro-image-preview');
};

export const relightImage = async (imageBase64: string, lightingDescription: string): Promise<string> => {
  return runImageTask(imageBase64, `Relight this image with: ${lightingDescription}.`);
};

export const runNanoBanana = async (prompt: string, imageBase64?: string): Promise<string> => {
  const ai = getAiClient();
  const model = 'gemini-2.5-flash-image';
  
  const parts: any[] = [];
  
  if (imageBase64) {
    parts.push({
      inlineData: {
        data: cleanBase64(imageBase64),
        mimeType: getMimeType(imageBase64),
      }
    });
    const editInstruction = prompt 
        ? `Edit the image: "${prompt}". Return modified image only.`
        : `Improve image quality significantly. Return modified image only.`;
        
    parts.push({ text: editInstruction });
  } else {
    parts.push({ text: prompt });
  }

  try {
      const response = await ai.models.generateContent({
        model: model,
        contents: { parts }
      });

      for (const part of response.candidates?.[0]?.content?.parts || []) {
        if (part.inlineData) {
          return `data:image/png;base64,${part.inlineData.data}`;
        }
      }
  } catch (e: any) {
      console.error(e);
  }
  throw new Error("حدث خطأ أثناء المعالجة.");
};

/**
 * VISION: Analyzes image/video content (Arabic Response)
 */
export const analyzeImage = async (imageBase64: string, prompt: string): Promise<string> => {
  const ai = getAiClient();
  const model = 'gemini-2.5-flash';

  const cleanData = cleanBase64(imageBase64);
  const mimeType = getMimeType(imageBase64);

  // Force Arabic response
  const finalPrompt = `${prompt}. \n\n هام جداً: أجب باللغة العربية فقط وبشكل احترافي ومفصل.`;

  const response = await ai.models.generateContent({
    model: model,
    contents: {
      parts: [
        {
          inlineData: {
            data: cleanData,
            mimeType: mimeType,
          },
        },
        { text: finalPrompt }
      ],
    },
  });

  return response.text || "لم يتمكن النظام من تحليل الصورة.";
};

/**
 * NEW: Analyzes video frame and returns JSON for auto-application
 */
export const analyzeVideoFrameForEditing = async (imageBase64: string): Promise<any> => {
  const ai = getAiClient();
  const model = 'gemini-2.5-flash';
  
  const cleanData = cleanBase64(imageBase64);
  const mimeType = getMimeType(imageBase64);

  const prompt = `
    Analyze this video frame. Suggest color correction settings.
    Return a JSON object with:
    - brightness: number (0-200, 100 is neutral)
    - contrast: number (0-200, 100 is neutral)
    - saturation: number (0-200, 100 is neutral)
    - filterPreset: string ("none", "warm", "cool", "vintage", "cyberpunk", "drama")
    - explanation: string (Arabic explanation of why these settings were chosen)
  `;

  try {
      const response = await ai.models.generateContent({
        model: model,
        contents: {
          parts: [{ inlineData: { data: cleanData, mimeType: mimeType } }, { text: prompt }]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              brightness: { type: Type.NUMBER },
              contrast: { type: Type.NUMBER },
              saturation: { type: Type.NUMBER },
              filterPreset: { type: Type.STRING },
              explanation: { type: Type.STRING }
            }
          }
        }
      });
      return JSON.parse(response.text || "{}");
  } catch (e) {
      console.error(e);
      return { explanation: "حدث خطأ في التحليل." };
  }
};

export const analyzeImageForSuggestions = async (imageBase64: string): Promise<any[]> => {
  const ai = getAiClient();
  const model = 'gemini-2.5-flash';
  
  const cleanData = cleanBase64(imageBase64);
  const mimeType = getMimeType(imageBase64);

  const prompt = `
    Analyze this image and provide 3 suggestions.
    Return JSON array. Properties: label (Arabic), description (Arabic), tool (REMOVE_BG, OBJECT_REMOVAL, REPLACE_BG, RELIGHT, UPSCALE, NANO_BANANA), prompt (English technical prompt).
  `;

  try {
      const response = await ai.models.generateContent({
        model: model,
        contents: {
          parts: [{ inlineData: { data: cleanData, mimeType: mimeType } }, { text: prompt }]
        },
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                description: { type: Type.STRING },
                tool: { type: Type.STRING },
                prompt: { type: Type.STRING }
              }
            }
          }
        }
      });
      return JSON.parse(response.text || "[]");
  } catch (e) {
      return [];
  }
};

export const generateVideo = async (prompt: string): Promise<string> => {
  const ai = getAiClient();
  const model = 'veo-3.1-fast-generate-preview';

  let operation = await ai.models.generateVideos({
    model: model,
    prompt: prompt,
    config: {
      numberOfVideos: 1,
      resolution: '720p',
      aspectRatio: '16:9'
    }
  });

  while (!operation.done) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    operation = await ai.operations.getVideosOperation({operation: operation});
  }

  const videoUri = operation.response?.generatedVideos?.[0]?.video?.uri;
  if (!videoUri) throw new Error("فشل توليد الفيديو");
  
  const apiKey = process.env.API_KEY || localStorage.getItem('GEMINI_API_KEY');
  const videoRes = await fetch(`${videoUri}&key=${apiKey}`);
  const blob = await videoRes.blob();
  return URL.createObjectURL(blob);
};

export const generateSpeech = async (text: string, voiceName: string = 'Kore'): Promise<string> => {
  const ai = getAiClient();
  const model = 'gemini-2.5-flash-preview-tts';

  const response = await ai.models.generateContent({
    model: model,
    contents: { parts: [{ text }] },
    config: {
      responseModalities: [Modality.AUDIO], 
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      }
    }
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64Audio) throw new Error("فشل توليد الصوت");

  return `data:audio/mp3;base64,${base64Audio}`;
};
