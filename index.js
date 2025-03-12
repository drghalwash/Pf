import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");
import axios from "axios";
import express from "express";
import fs from "fs";
import { parseSpecificPages } from "./specifyPages.js";

const extractMCQs = async (text) => {
  console.log({ text });
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer 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`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "anthropic/claude-3-haiku", // Better at structured output
          messages: [
            {
              role: "system",
              content: `Extract MCQs from this text: ${text} and return ONLY JSON in this format: 
              {
                "questions": [
                  {
                    "question": "question text",
                    "options": {
                      "A": "option text",
                      "B": "option text",
                      // ...
                    },
                    "correct_answer": "A"
                  }
                ]
              }
              If no questions found, return {"questions": []}`,
            },
            {
              role: "user",
              content: `Extract multiple-choice questions from this text:\n\n${text}`,
            },
          ],
          temperature: 0, // For more deterministic output
          response_format: { type: "json_object" }, // Requires a model that supports JSON mode
        }),
      }
    );

    const data = await response.json();
    const content = data.choices[0].message.content;
    console.log({ content });

    // Parse the JSON string from the response
    try {
      return JSON.parse(content);
    } catch (e) {
      console.error("Failed to parse JSON:", content);
      return { questions: [] };
    }
  } catch (error) {
    console.error("Error extracting MCQs:", error);
    return { questions: [] };
  }
};

// Usage example
// const pdfData = `Your text containing questions here...`;

const data = fs.readFileSync("./Get Through SBAs.pdf");
const pdfData = await pdfParse(data);
const text = pdfData.text;

const app = express();
const port = 3000;

app.get("/", async (req, res) => {
  // const text = await parseSpecificPages("./Get Through SBAs.pdf", [
  //   [13, 18], // to questions no 27
  //   [73, 77], // to answers no 27
  // ]);

  // const text = await parseSpecificPages(
  //   "./surgerybook_net_Rush_University.pdf",
  //   [
  //     [10, 16],
  //     [17, 21],
  //   ]
  // );

  // const questions = await parseSpecificPages("./de Virgilio 2nd.pdf", [
  //   [15, 17],
  // ]);

  // const answers = await parseSpecificPages("./de Virgilio 2nd.pdf", [[18, 22]]);
  const text = await parseSpecificPages("./Virgilio 2nd.Pdf", [[14, 22]]);

  // const text = await parseSpecificPages("./PreTest 13th.pdf", [[9, 22]]);

  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          // gemini
          // Authorization: `Bearer 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`,
          // deepseek
          Authorization: `Bearer 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`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          // model: "anthropic/claude-3-haiku", // Better at structured output
          // model: "google/gemini-2.0-pro-exp-02-05:free",
          model: "deepseek/deepseek-r1-zero:free",
          messages: [
            {
              role: "system",
              content: `You are a system that extracts multiple-choice questions (MCQs) from input text, the correct answer for each question and the explantion of  correct answer. Always respond in JSON format only, DO NOT NOT add any explanations or text outside of this JSON structure. Get the answers and their explanation from the given text each question has its correct choice with the correct answer explaination. The format is:
  {
    "questions": [
      {
        "question": "question text",
        "options": {
          "A": "option text",
          "B": "option text",
          ...
        },
        "correct_answer": "A",
        "answer_details": "The lung is invested by and enclosed in a serous pleural sac consisting of two continuous
membranes: the visceral pleura investing all surfaces of the lungs and the parietal pleura lining the
pulmo..." 
      }
    ]
  }
  If no questions are found, respond with: {"questions": []}. Do not add any explanations or text outside of this JSON structure.`,
            },
            {
              role: "user",
              content: `Extract multiple-choice questions from this text:\n\n${text}`,
              // content: `Extract multiple-choice questions from this text:\n\n${questions} and answers from ${answers}`,
            },
          ],
          temperature: 0, // For more deterministic output
          response_format: { type: "json_object" }, // Requires a model that supports JSON mode
        }),
      }
    );

    const data = await response.json();

    const content = data.choices[0].message.content;
    // return res.json({ content });

    const jsonStartIndex = content.indexOf("{");
    const jsonString = content.slice(jsonStartIndex);

    const parsed = JSON.parse(jsonString);
    return res.json({ parsed });

    // Parse the JSON string from the response
    // try {
    //   return JSON.parse(content);
    // } catch (e) {
    //   console.error("Failed to parse JSON:", content);
    //   return { questions: [] };
    // }
  } catch (error) {
    return res.json({ error: error.message });
  }
});
app.listen(port, () => console.log(`Example app listening on port ${port}!`));
