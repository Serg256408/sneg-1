
import { GoogleGenAI } from "@google/genai";
import { Order } from "../types";

// Always use the process.env.API_KEY directly for initialization as per guidelines.
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export const getOrderInsights = async (orders: Order[]) => {
  if (orders.length === 0) return "Нет активных заказов для анализа.";

  const prompt = `Проанализируй текущий список заказов на вывоз снега в Москве:
  ${JSON.stringify(orders)}

  Предоставь краткий отчет для диспетчера:
  1. Общий прогресс (план против факта).
  2. Проблемные зоны (где не найдена техника или нет оплаты).
  3. Рекомендации по оптимизации.
  Отвечай на русском языке, профессионально и кратко.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: prompt,
      config: {
        thinkingConfig: { thinkingBudget: 0 }
      }
    });
    return response.text || "Не удалось получить аналитику.";
  } catch (error) {
    console.error("Gemini Error:", error);
    return "Ошибка при получении аналитики ИИ.";
  }
};
