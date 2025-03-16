import * as dotenv from 'dotenv';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { createRequire } from "module";
import { createClient } from '@supabase/supabase-js';
import { parseSpecificPages } from "./src/helpers/specifyPages.js";

// Initialize environment
dotenv.config();
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Express app setup
const app = express();
app.use(cors());
const port = process.env.PORT ?? 8000;
app.use(express.json({ limit: '50mb' }));

/**
 * Improved extraction system using chapter structure awareness
 */
const CHAPTER_PATTERNS = {
  // Chapter heading patterns
  CHAPTER_TITLE: /^\s*(?:Chapter\s+\d+[\.:]?\s*)?([A-Z][A-Za-z\s,:-]+(?:Care|Surgery|Problems|Shock|Endocrine|Breast|Tract|Pancreas|Liver))/m,
  
  // Section patterns
  QUESTIONS_SECTION: /^\s*(?:Questions|QUESTIONS)\s*$/m,
  ANSWERS_SECTION: /^\s*(?:Answers|ANSWERS|Answers and Explanations|ANSWERS AND EXPLANATIONS)\s*$/m,
  
  // Question patterns (must be global)
  QUESTION_PATTERN: /(\d+)\.\s+(.*?)(?=\s*\d+\.|$)/gs,
  
  // Option patterns (must be global)
  OPTIONS_PATTERN_UPPERCASE: /([A-E])\.\s+(.*?)(?=\s*[A-E]\.|$)/g,
  OPTIONS_PATTERN_LOWERCASE: /([a-e])\.\s+(.*?)(?=\s*[a-e]\.|$)/g,
  
  // Answer patterns (must be global)
  ANSWER_PATTERN_VIRGILIO: /(\d+)\.\s+([A-E])\.?\s+(.*?)(?=\s*\d+\.\s+[A-E]|$)/gs,
  ANSWER_PATTERN_PRETEST: /(\d+)\.\s+The\s+answer\s+is\s+([a-e])\.?\s+(.*?)(?=\s*\d+\.\s+|$)/gs
};

/**
 * Detect PDF format based on content analysis
 */
function detectPDFFormat(text, filename) {
  console.log(`Analyzing format for: ${filename}`);
  
  const lowerFilename = filename.toLowerCase();
  
  // Format detection based on filename
  if (lowerFilename.includes('virgilio')) {
    return 'VIRGILIO';
  } else if (lowerFilename.includes('pretest')) {
    return 'PRETEST';
  } else if (lowerFilename.includes('schwartz')) {
    return 'SCHWARTZ';
  }
  
  // Format detection based on content patterns
  if (text.includes('de Virgilio') || text.match(/Areg\s+Grigorian/i)) {
    return 'VIRGILIO';
  } else if (text.includes('PreTest') || text.match(/The\s+answer\s+is\s+[a-e]/i)) {
    return 'PRETEST';
  } else if (text.includes('Schwartz')) {
    return 'SCHWARTZ';
  }
  
  return 'GENERIC';
}

/**
 * Extract chapters from text
 */
function extractChapters(text) {
  // Split text into lines for easier processing
  const lines = text.split('\n');
  const chapters = [];
  let currentChapter = null;
  
  // First pass: identify chapter structure
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Check for chapter titles
    const chapterMatch = line.match(CHAPTER_PATTERNS.CHAPTER_TITLE);
    if (chapterMatch && line.length < 80) { // Avoid matching long paragraphs
      currentChapter = {
        title: chapterMatch[1].trim(),
        index: chapters.length + 1,
        startLine: i,
        endLine: null,
        content: [],
        sections: {}
      };
      chapters.push(currentChapter);
      continue;
    }
    
    // Check for QUESTIONS section
    if (line.match(CHAPTER_PATTERNS.QUESTIONS_SECTION)) {
      if (currentChapter) {
        currentChapter.sections.questions = { startLine: i + 1 };
      }
      continue;
    }
    
    // Check for ANSWERS section
    if (line.match(CHAPTER_PATTERNS.ANSWERS_SECTION)) {
      if (currentChapter) {
        currentChapter.sections.answers = { startLine: i + 1 };
        // Mark the end of the questions section if we find answers
        if (currentChapter.sections.questions && !currentChapter.sections.questions.endLine) {
          currentChapter.sections.questions.endLine = i;
        }
      }
      continue;
    }
    
    // Accumulate content for the current chapter
    if (currentChapter) {
      currentChapter.content.push(line);
    }
  }
  
  // Close the last chapter if needed
  if (chapters.length > 0) {
    const lastChapter = chapters[chapters.length - 1];
    if (!lastChapter.endLine) {
      lastChapter.endLine = lines.length - 1;
    }
  }
  
  return chapters;
}

/**
 * Extract questions from a chapter
 */
function extractQuestionsFromChapter(chapter, text, format) {
  const questions = [];
  
  // Handle the case where we don't have properly identified sections
  if (!chapter.sections.questions) {
    return [];
  }
  
  // Get text for questions section
  const startIndex = chapter.sections.questions.startLine;
  const endIndex = chapter.sections.questions.endLine || text.split('\n').length;
  const questionsText = text.split('\n').slice(startIndex, endIndex).join('\n');
  
  // Extract questions with a better pattern that handles multi-line questions
  let questionMatch;
  CHAPTER_PATTERNS.QUESTION_PATTERN.lastIndex = 0;
  
  while ((questionMatch = CHAPTER_PATTERNS.QUESTION_PATTERN.exec(questionsText)) !== null) {
    const questionNumber = parseInt(questionMatch[1]);
    const questionText = questionMatch[2].trim();
    
    // Extract question block to find options
    const currentIndex = questionMatch.index;
    const nextQuestionMatch = questionsText.indexOf(`${questionNumber + 1}.`, currentIndex);
    const questionBlock = nextQuestionMatch !== -1 ? 
      questionsText.substring(currentIndex, nextQuestionMatch) : 
      questionsText.substring(currentIndex);
    
    // Extract options based on format
    const options = {};
    let optionPattern = format === 'PRETEST' ? 
      CHAPTER_PATTERNS.OPTIONS_PATTERN_LOWERCASE : 
      CHAPTER_PATTERNS.OPTIONS_PATTERN_UPPERCASE;
    
    optionPattern.lastIndex = 0;
    let optionMatch;
    
    while ((optionMatch = optionPattern.exec(questionBlock)) !== null) {
      const letter = optionMatch[1].toUpperCase();
      const optionText = optionMatch[2].trim();
      options[letter] = optionText;
    }
    
    // Only add question if we have options
    if (Object.keys(options).length > 0) {
      questions.push({
        question_number: questionNumber,
        question: questionText,
        options: options,
        chapter: chapter.title,
        chapter_index: chapter.index,
        setorder: questions.length + 1,
        correct_answer: '',
        answer_details: ''
      });
    }
  }
  
  return questions;
}

/**
 * Extract answers from a chapter and match with questions
 */
function extractAnswersForChapter(chapter, text, questions, format) {
  // If no answers section identified, return questions unchanged
  if (!chapter.sections.answers) {
    return questions;
  }
  
  // Get text for answers section
  const startIndex = chapter.sections.answers.startLine;
  const endIndex = chapter.endLine || text.split('\n').length;
  const answersText = text.split('\n').slice(startIndex, endIndex).join('\n');
  
  // Select appropriate answer pattern based on format
  const answerPattern = format === 'PRETEST' ? 
    CHAPTER_PATTERNS.ANSWER_PATTERN_PRETEST : 
    CHAPTER_PATTERNS.ANSWER_PATTERN_VIRGILIO;
  
  // Extract answers
  answerPattern.lastIndex = 0;
  let answerMatch;
  const answerMap = {};
  
  while ((answerMatch = answerPattern.exec(answersText)) !== null) {
    const answerNumber = parseInt(answerMatch[1]);
    const correctLetter = answerMatch[2].toUpperCase();
    const answerDetails = answerMatch[3] ? answerMatch[3].trim() : '';
    
    answerMap[answerNumber] = {
      correct_answer: correctLetter,
      answer_details: answerDetails
    };
  }
  
  // Match answers with questions
  return questions.map(q => {
    const answer = answerMap[q.question_number];
    if (answer) {
      return {
        ...q,
        correct_answer: answer.correct_answer,
        answer_details: answer.answer_details
      };
    }
    return q;
  });
}

/**
 * Extract all questions and answers from PDF content
 */
function extractQuestionsAndAnswers(text, format) {
  const chapters = extractChapters(text);
  console.log(`Found ${chapters.length} chapters`);
  
  let allQuestions = [];
  let globalOrder = 0;
  
  // Process each chapter
  for (const chapter of chapters) {
    console.log(`Processing chapter: ${chapter.title}`);
    
    // Extract questions from chapter
    const chapterQuestions = extractQuestionsFromChapter(chapter, text, format);
    console.log(`Found ${chapterQuestions.length} questions in chapter`);
    
    // Extract answers and match with questions
    const questionsWithAnswers = extractAnswersForChapter(chapter, text, chapterQuestions, format);
    
    // Set global ordering
    const processedQuestions = questionsWithAnswers.map(q => ({
      ...q,
      setorder: ++globalOrder
    }));
    
    allQuestions = allQuestions.concat(processedQuestions);
  }
  
  return allQuestions;
}

/**
 * Fallback to AI extraction when pattern extraction fails
 */
async function processWithAI(text, bookName) {
  console.log(`Using AI extraction for ${bookName}`);
  
  try {
    const response = await fetch(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GEMINI_API_KEY_PARSE}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.0-pro-exp-02-05:free",
          messages: [
            {
              role: "system",
              content: `Extract medical multiple-choice questions with chapter information into this JSON structure:

{
  "chapters": [
    {
      "title": "Chapter title (e.g., 'Pre- and Postoperative Care')",
      "index": 1,
      "questions": [
        {
          "question_number": 1,
          "question": "Complete question text",
          "options": {
            "A": "First option text",
            "B": "Second option text",
            "C": "Third option text",
            "D": "Fourth option text",
            "E": "Fifth option text if present"
          },
          "correct_answer": "Letter of correct answer (A-E)",
          "answer_details": "Complete explanation text"
        }
      ]
    }
  ]
}`
            },
            {
              role: "user",
              content: `Extract all multiple-choice questions from this medical textbook excerpt, organized by chapters:\n\n${text.substring(0, 50000)}`
            }
          ],
          temperature: 0,
          response_format: { type: "json_object" }
        })
      }
    );

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    
    try {
      // Safely extract JSON
      const jsonStart = content.indexOf('{');
      const jsonEnd = content.lastIndexOf('}') + 1;
      
      if (jsonStart === -1 || jsonEnd <= jsonStart) {
        throw new Error('No valid JSON found in AI response');
      }
      
      const jsonString = content.substring(jsonStart, jsonEnd);
      const parsed = JSON.parse(jsonString);
      
      if (!parsed.chapters || !Array.isArray(parsed.chapters)) {
        throw new Error('Invalid chapters array in JSON');
      }
      
      // Convert to flat question list with chapter info
      const questions = [];
      let globalOrder = 0;
      
      for (const chapter of parsed.chapters) {
        for (const q of (chapter.questions || [])) {
          questions.push({
            question: q.question,
            options: q.options || {},
            correct_answer: q.correct_answer || "",
            answer_details: q.answer_details || "",
            chapter: chapter.title || "Unknown Chapter",
            chapter_index: chapter.index || 0,
            question_number: q.question_number || 0,
            setorder: ++globalOrder,
            bookname: bookName
          });
        }
      }
      
      console.log(`AI extraction found ${questions.length} questions across ${parsed.chapters.length} chapters`);
      return questions;
    } catch (parseError) {
      console.error(`Error parsing AI response: ${parseError.message}`);
      return [];
    }
  } catch (error) {
    console.error(`AI extraction error: ${error.message}`);
    return [];
  }
}

/**
 * Process a job to extract questions from PDF
 */
async function processJob(job) {
  console.log(`Starting job ${job.id} for ${job.book}, pages ${job.range}`);
  
  try {
    // Update job status
    await updateJobStatus(job.id, 'processing', {
      startedAt: new Date().toISOString()
    });

    // Parse page range
    const [startPage, endPage] = job.range.split('-').map(num => parseInt(num));
    const bookName = job.book;

    if (!bookName || isNaN(startPage) || isNaN(endPage)) {
      throw new Error('Invalid parameters');
    }

    const filePath = path.resolve(`./books/${bookName}`);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    await updateJobStatus(job.id, 'processing', {
      progress: 'File validated, extracting text...'
    });
    
    // Extract text from PDF
    const text = await parseSpecificPages(filePath, [[startPage, endPage]]);
    if (!text || text.length < 500) {
      throw new Error('Insufficient text extracted from PDF');
    }
    
    // Detect format
    const format = detectPDFFormat(text, bookName);
    console.log(`Detected format: ${format}`);
    
    await updateJobStatus(job.id, 'processing', {
      progress: `Format detected: ${format}, processing content...`,
      detectedFormat: format
    });

    // Extract questions with pattern-based chapter extraction
    let questions = extractQuestionsAndAnswers(text, format);
    console.log(`Pattern-based extraction found ${questions.length} questions`);
    
    // Fall back to AI if needed
    if (questions.length < 5) {
      await updateJobStatus(job.id, 'processing', {
        progress: 'Pattern extraction insufficient, using AI extraction...'
      });
      
      questions = await processWithAI(text, bookName);
      console.log(`AI extraction found ${questions.length} questions`);
    }

    if (questions.length === 0) {
      throw new Error('No valid questions found in page range');
    }

    // Add bookname to questions
    questions = questions.map(q => ({
      ...q,
      bookname: bookName
    }));

    // Save to database with chunking
    const CHUNK_SIZE = 20;
    let savedCount = 0;
    
    for (let i = 0; i < questions.length; i += CHUNK_SIZE) {
      const chunk = questions.slice(i, i + CHUNK_SIZE);
      
      try {
        const { error } = await supabase
          .from('quiz_questions')
          .insert(chunk);
        
        if (error) {
          console.error(`Database error: ${error.message}`);
        } else {
          savedCount += chunk.length;
        }
      } catch (dbError) {
        console.error(`Error saving questions: ${dbError.message}`);
      }
      
      // Small delay between chunks
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    await updateJobStatus(job.id, 'completed', {
      questionCount: questions.length,
      savedCount: savedCount,
      pageRange: `${startPage}-${endPage}`,
      format: format,
      completedAt: new Date().toISOString()
    });

    console.log(`Job ${job.id} completed: ${savedCount} questions saved`);
  } catch (error) {
    console.error(`Job ${job.id} failed: ${error.message}`);
    
    await updateJobStatus(job.id, 'failed', {
      error: error.message,
      failedAt: new Date().toISOString()
    });
  }
}

/**
 * Update job status
 */
async function updateJobStatus(jobId, status, logs = {}) {
  try {
    const { data, error: fetchError } = await supabase
      .from('parsestart')
      .select('logs')
      .eq('id', jobId)
      .single();
    
    if (fetchError) {
      console.error(`Error fetching job: ${fetchError.message}`);
      return;
    }
    
    const updatedLogs = { 
      ...data?.logs || {}, 
      ...logs,
      lastUpdated: new Date().toISOString()
    };
    
    const { error } = await supabase
      .from('parsestart')
      .update({ 
        status, 
        logs: updatedLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', jobId);
    
    if (error) {
      console.error(`Error updating job: ${error.message}`);
    }
  } catch (error) {
    console.error(`Error in updateJobStatus: ${error.message}`);
  }
}

/**
 * Check for pending jobs
 */
async function checkPendingJobs() {
  try {
    const { data, error } = await supabase
      .from('parsestart')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);
    
    if (error) {
      throw new Error(`Error fetching pending jobs: ${error.message}`);
    }
    
    if (data && data.length > 0) {
      await processJob(data[0]);
    }
  } catch (error) {
    console.error(`Error in checkPendingJobs: ${error.message}`);
  }
}

// API Routes
app.get("/parse-book", async (req, res) => {
  try {
    const bookName = req.query.book;
    const startPage = parseInt(req.query.start);
    const endPage = parseInt(req.query.end);
    
    if (!bookName || isNaN(startPage) || isNaN(endPage)) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }
    
    const { data, error } = await supabase
      .from('parsestart')
      .insert([{
        book: bookName,
        range: `${startPage}-${endPage}`,
        status: 'pending',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }])
      .select();
    
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    
    return res.status(201).json({ 
      message: "Job created successfully",
      jobId: data[0].id 
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  
  // Process pending jobs
  checkPendingJobs();
  setInterval(checkPendingJobs, 60000);
});

export { app, processJob };
