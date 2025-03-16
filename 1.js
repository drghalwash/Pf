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

// Setup Express app
const app = express();
app.use(cors());
const port = process.env.PORT ?? 8000;
app.use(express.json({ limit: '50mb' }));

/**
 * Define chapter and section detection patterns
 */
const STRUCTURE_PATTERNS = {
  // Chapter patterns
  CHAPTER_HEADER: /(?:(?:\n|\r|\r\n)\s*(?:Chapter|CHAPTER)\s+\d+[:.]\s+([^\n\r]+)|(?:\n|\r|\r\n)\s*([A-Z][A-Za-z\s,:-]+(?:Care|Surgery|Problems|Breast|Tract|Pancreas|Liver))(?:\s*\n|\s*\r|\s*\r\n))/g,
  
  // Section patterns
  QUESTIONS_SECTION: /(?:\n|\r|\r\n)\s*(?:Questions|QUESTIONS)\s*(?:\n|\r|\r\n)/g,
  ANSWERS_SECTION: /(?:\n|\r|\r\n)\s*(?:Answers|ANSWERS|Answers\s+and\s+Explanations|ANSWERS\s+AND\s+EXPLANATIONS)\s*(?:\n|\r|\r\n)/g,
  
  // Question patterns
  VIRGILIO_QUESTION: /(\d+)\.\s+(.*?)(?=\n\s*[A-E]\.\s+)/gs,
  PRETEST_QUESTION: /(\d+)\.\s+(.*?)(?=\n\s*[a-e]\.\s+)/gs,
  
  // Options patterns
  VIRGILIO_OPTIONS: /([A-E])\.\s+(.*?)(?=\n\s*(?:[A-E]\.|(?:\d+)\.))/gs,
  PRETEST_OPTIONS: /([a-e])\.\s+(.*?)(?=\n\s*(?:[a-e]\.|(?:\d+)\.))/gs,
  
  // Answer patterns
  VIRGILIO_ANSWER: /(\d+)\.\s+([A-E])[\.|\s](.*?)(?=\n\s*\d+\.|$)/gs,
  PRETEST_ANSWER: /(\d+)\.\s+The\s+answer\s+is\s+([a-e])\.\s+(.*?)(?=\n\s*\d+\.|$)/gs
};

/**
 * Detect PDF format with improved accuracy
 */
function detectPDFFormat(text, filename) {
  console.log(`Analyzing format for: ${filename}`);
  
  const lowerFilename = filename.toLowerCase();
  const lowerText = text.toLowerCase().substring(0, 10000);
  
  // Primary format detection based on filename
  if (lowerFilename.includes('virgilio')) return 'VIRGILIO';
  if (lowerFilename.includes('pretest')) return 'PRETEST';
  if (lowerFilename.includes('schwartz')) return 'SCHWARTZ';
  
  // Secondary detection based on content patterns
  if (lowerText.includes('de virgilio') || lowerText.includes('areg grigorian')) return 'VIRGILIO';
  if (lowerText.includes('pretest') || lowerText.includes('the answer is')) return 'PRETEST';
  if (lowerText.includes('schwartz') || lowerText.includes('principles of surgery')) return 'SCHWARTZ';
  
  // Default to generic format
  return 'GENERIC';
}

/**
 * Extract chapter structure from text
 */
function extractChapterStructure(text) {
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\f/g, '\n');
  const chapters = [];
  
  // First pass: identify chapter boundaries
  let chapterMatch;
  let currentChapterTitle = "Unknown Chapter";
  let chapterIndex = 1;

  // Reset regex to start from beginning
  STRUCTURE_PATTERNS.CHAPTER_HEADER.lastIndex = 0;
  
  while ((chapterMatch = STRUCTURE_PATTERNS.CHAPTER_HEADER.exec(normalizedText)) !== null) {
    const title = chapterMatch[1] || chapterMatch[2];
    if (title && title.trim().length > 3) {
      chapters.push({
        title: title.trim(),
        index: chapterIndex++,
        startIndex: chapterMatch.index,
        endIndex: null,
        content: "",
        sections: {}
      });
    }
  }
  
  // Set end boundaries for chapters
  for (let i = 0; i < chapters.length; i++) {
    if (i < chapters.length - 1) {
      chapters[i].endIndex = chapters[i+1].startIndex;
    } else {
      chapters[i].endIndex = normalizedText.length;
    }
    chapters[i].content = normalizedText.substring(chapters[i].startIndex, chapters[i].endIndex);
  }
  
  // If no chapters detected, create a default chapter
  if (chapters.length === 0) {
    chapters.push({
      title: "Default Chapter",
      index: 1,
      startIndex: 0,
      endIndex: normalizedText.length,
      content: normalizedText,
      sections: {}
    });
  }
  
  // Second pass: identify question and answer sections within each chapter
  for (const chapter of chapters) {
    // Find Questions section
    STRUCTURE_PATTERNS.QUESTIONS_SECTION.lastIndex = 0;
    const questionsMatch = STRUCTURE_PATTERNS.QUESTIONS_SECTION.exec(chapter.content);
    
    if (questionsMatch) {
      chapter.sections.questions = {
        startIndex: questionsMatch.index,
        content: ""
      };
    }
    
    // Find Answers section
    STRUCTURE_PATTERNS.ANSWERS_SECTION.lastIndex = 0;
    const answersMatch = STRUCTURE_PATTERNS.ANSWERS_SECTION.exec(chapter.content);
    
    if (answersMatch) {
      chapter.sections.answers = {
        startIndex: answersMatch.index,
        content: ""
      };
      
      // Set end of questions section if we found answers
      if (chapter.sections.questions) {
        chapter.sections.questions.endIndex = answersMatch.index;
        chapter.sections.questions.content = chapter.content.substring(
          chapter.sections.questions.startIndex,
          chapter.sections.questions.endIndex
        );
      }
      
      // Set content for answers section
      chapter.sections.answers.endIndex = chapter.content.length;
      chapter.sections.answers.content = chapter.content.substring(
        chapter.sections.answers.startIndex,
        chapter.sections.answers.endIndex
      );
    }
    
    // If we didn't find explicit sections, use the entire chapter
    if (!chapter.sections.questions) {
      // Search for first question
      const firstQuestionMatch = chapter.content.match(/\n\s*1\.\s+/);
      if (firstQuestionMatch) {
        const answerSectionIndex = chapter.content.indexOf("Answers");
        if (answerSectionIndex > 0) {
          chapter.sections.questions = {
            startIndex: firstQuestionMatch.index,
            endIndex: answerSectionIndex,
            content: chapter.content.substring(firstQuestionMatch.index, answerSectionIndex)
          };
          
          chapter.sections.answers = {
            startIndex: answerSectionIndex,
            endIndex: chapter.content.length,
            content: chapter.content.substring(answerSectionIndex)
          };
        } else {
          // Just split in half if no answer section found
          const midpoint = Math.floor(chapter.content.length / 2);
          chapter.sections.questions = {
            startIndex: firstQuestionMatch.index,
            endIndex: midpoint,
            content: chapter.content.substring(firstQuestionMatch.index, midpoint)
          };
          
          chapter.sections.answers = {
            startIndex: midpoint,
            endIndex: chapter.content.length,
            content: chapter.content.substring(midpoint)
          };
        }
      }
    }
  }
  
  return chapters;
}

/**
 * Extract questions, options, and answers from a chapter
 */
function extractQuestionsFromChapter(chapter, format) {
  const questions = [];
  
  if (!chapter.sections.questions || !chapter.sections.answers) {
    console.log(`Skipping chapter "${chapter.title}" - missing questions or answers sections`);
    return questions;
  }
  
  // Select appropriate patterns based on format
  const questionPattern = format === 'PRETEST' ? 
    STRUCTURE_PATTERNS.PRETEST_QUESTION : 
    STRUCTURE_PATTERNS.VIRGILIO_QUESTION;
    
  const optionsPattern = format === 'PRETEST' ? 
    STRUCTURE_PATTERNS.PRETEST_OPTIONS : 
    STRUCTURE_PATTERNS.VIRGILIO_OPTIONS;
    
  const answerPattern = format === 'PRETEST' ? 
    STRUCTURE_PATTERNS.PRETEST_ANSWER : 
    STRUCTURE_PATTERNS.VIRGILIO_ANSWER;
  
  // Extract answers first into a map
  const answers = {};
  let answerMatch;
  
  // Reset lastIndex
  answerPattern.lastIndex = 0;
  
  while ((answerMatch = answerPattern.exec(chapter.sections.answers.content)) !== null) {
    const questionNumber = answerMatch[1];
    const correctAnswer = answerMatch[2].toUpperCase();
    const explanation = answerMatch[3].trim();
    
    answers[questionNumber] = {
      correct_answer: correctAnswer,
      answer_details: explanation
    };
  }
  
  // Now extract questions and options
  let questionMatch;
  
  // Reset lastIndex
  questionPattern.lastIndex = 0;
  
  while ((questionMatch = questionPattern.exec(chapter.sections.questions.content)) !== null) {
    const questionNumber = parseInt(questionMatch[1]);
    const questionText = questionMatch[2].trim();
    
    // Find section of text that contains the options for this question
    const currentPosition = questionMatch.index;
    const nextQuestionMatch = chapter.sections.questions.content.indexOf(`${questionNumber + 1}.`, currentPosition);
    const questionEndPosition = nextQuestionMatch !== -1 ? 
      nextQuestionMatch : 
      chapter.sections.questions.content.length;
    
    const questionBlock = chapter.sections.questions.content.substring(
      currentPosition, 
      questionEndPosition
    );
    
    // Extract options
    const options = {};
    let optionMatch;
    
    // Reset lastIndex
    optionsPattern.lastIndex = 0;
    
    while ((optionMatch = optionsPattern.exec(questionBlock)) !== null) {
      const optionLetter = optionMatch[1].toUpperCase();
      const optionText = optionMatch[2].trim();
      
      options[optionLetter] = optionText;
    }
    
    // Only add question if we found options
    if (Object.keys(options).length > 0) {
      // Get answer data if available
      const answer = answers[questionNumber.toString()] || {};
      
      questions.push({
        question: questionText,
        options: options,
        correct_answer: answer.correct_answer || "",
        answer_details: answer.answer_details || "",
        chapter: chapter.title,
        chapter_index: chapter.index,
        question_number: questionNumber,
        setorder: null // Will be set later
      });
    }
  }
  
  return questions;
}

/**
 * Extract all questions from all chapters
 */
function extractAllQuestions(text, format) {
  // Extract chapter structure
  const chapters = extractChapterStructure(text);
  console.log(`Found ${chapters.length} chapters`);
  
  // Extract questions from each chapter
  let allQuestions = [];
  let globalOrder = 0;
  
  for (const chapter of chapters) {
    console.log(`Processing chapter: ${chapter.title} (${chapter.index})`);
    
    const chapterQuestions = extractQuestionsFromChapter(chapter, format);
    console.log(`Found ${chapterQuestions.length} questions in chapter ${chapter.title}`);
    
    // Assign global order (setorder)
    const questionsWithOrder = chapterQuestions.map(q => ({
      ...q,
      setorder: ++globalOrder
    }));
    
    allQuestions = allQuestions.concat(questionsWithOrder);
  }
  
  return allQuestions;
}

/**
 * Process with AI when pattern extraction fails
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
              content: `You are a specialized system for extracting medical multiple-choice questions from textbooks. Extract questions with CHAPTER ORGANIZATION using this structure:

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
}

IMPORTANT RULES:
1. Maintain original question numbering exactly as in the text
2. Preserve chapter organization - each chapter should have its own questions
3. Include ALL questions in each chapter - they must match the original count
4. Make options EXACTLY A, B, C, D, E (capital letters)
5. Include the COMPLETE explanation for each answer
6. Return ONLY valid JSON`
            },
            {
              role: "user",
              content: `Extract all multiple-choice questions with their chapters from this medical textbook excerpt:\n\n${text.substring(0, 50000)}`
            }
          ],
          temperature: 0,
          response_format: { type: "json_object" },
          timeout: 180
        })
      }
    );

    if (!response.ok) {
      throw new Error(`AI API error: ${response.statusText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    
    try {
      // Extract valid JSON
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
      
      // Convert to flat questions list with chapter info
      const questions = [];
      let globalOrder = 0;
      
      for (const chapter of parsed.chapters) {
        const chapterTitle = chapter.title || "Unknown Chapter";
        const chapterIndex = chapter.index || 0;
        
        for (const q of (chapter.questions || [])) {
          questions.push({
            question: q.question,
            options: q.options || {},
            correct_answer: q.correct_answer || "",
            answer_details: q.answer_details || "",
            chapter: chapterTitle,
            chapter_index: chapterIndex,
            question_number: q.question_number || 0,
            setorder: ++globalOrder,
            bookname: bookName
          });
        }
      }
      
      console.log(`AI extraction found ${questions.length} questions in ${parsed.chapters.length} chapters`);
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
 * Save questions to database with proper error handling
 */
async function saveQuestionsToDatabase(questions, bookName) {
  if (!questions || questions.length === 0) {
    console.log('No questions to save');
    return false;
  }
  
  try {
    console.log(`Saving ${questions.length} questions to database`);
    
    // Add bookname to all questions
    const processedQuestions = questions.map(q => ({
      ...q,
      bookname: bookName,
      active: true,
      created_at: new Date().toISOString()
    }));
    
    // Insert in chunks to avoid payload size limits
    const CHUNK_SIZE = 20;
    let successCount = 0;
    
    for (let i = 0; i < processedQuestions.length; i += CHUNK_SIZE) {
      const chunk = processedQuestions.slice(i, i + CHUNK_SIZE);
      console.log(`Inserting chunk ${i/CHUNK_SIZE + 1} (${chunk.length} questions)`);
      
      const { error } = await supabase
        .from('quiz_questions')
        .insert(chunk);
      
      if (error) {
        console.error(`Database error: ${error.message}`);
      } else {
        successCount += chunk.length;
      }
      
      // Small delay between chunks
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`Successfully saved ${successCount} of ${questions.length} questions`);
    return successCount > 0;
  } catch (error) {
    console.error(`Database error: ${error.message}`);
    return false;
  }
}

/**
 * Process a job to extract questions from a PDF
 */
async function processJob(job) {
  console.log(`Starting job ${job.id} for ${job.book}, pages ${job.range}`);
  
  try {
    // Update job status to processing
    await updateJobStatus(job.id, 'processing', {
      startedAt: new Date().toISOString()
    });

    // Parse page range
    const [startPage, endPage] = job.range.split('-').map(num => parseInt(num));
    const bookName = job.book;

    // Validate inputs
    if (!bookName || isNaN(startPage) || isNaN(endPage) || startPage >= endPage) {
      throw new Error('Invalid parameters: Please provide valid book name, start page, and end page');
    }

    const filePath = path.resolve(`./books/${bookName}`);

    // Check if file exists and is PDF
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }
    
    if (path.extname(filePath).toLowerCase() !== '.pdf') {
      throw new Error('File is not a PDF');
    }

    await updateJobStatus(job.id, 'processing', {
      progress: 'File validated, extracting text...'
    });
    
    // Extract text from PDF
    let text;
    try {
      text = await parseSpecificPages(filePath, [[startPage, endPage]]);
      
      if (!text || text.length < 500) {
        throw new Error('Insufficient text extracted from PDF');
      }
    } catch (extractError) {
      throw new Error(`PDF extraction error: ${extractError.message}`);
    }
    
    // Detect format
    const format = detectPDFFormat(text, bookName);
    console.log(`Detected format for ${bookName}: ${format}`);
    
    await updateJobStatus(job.id, 'processing', {
      progress: `Format detected: ${format}, processing content...`,
      detectedFormat: format
    });

    // Extract questions using pattern-based chapter-aware extraction
    let questions = extractAllQuestions(text, format);
    console.log(`Pattern-based extraction found ${questions.length} questions`);
    
    // Fall back to AI if pattern-based extraction found few questions
    if (questions.length < 5) {
      await updateJobStatus(job.id, 'processing', {
        progress: 'Pattern extraction insufficient, using AI extraction...'
      });
      
      try {
        questions = await processWithAI(text, bookName);
        console.log(`AI extraction found ${questions.length} questions`);
      } catch (aiError) {
        console.error(`AI extraction failed: ${aiError.message}`);
        
        if (questions.length === 0) {
          throw new Error(`Failed to extract questions: ${aiError.message}`);
        }
      }
    }

    // Handle case where no questions were found
    if (questions.length === 0) {
      throw new Error('No valid questions found in specified page range');
    }

    // Save to database
    const saveSuccess = await saveQuestionsToDatabase(questions, bookName);
    
    if (!saveSuccess) {
      throw new Error('Failed to save questions to database');
    }

    // Update job status to completed
    await updateJobStatus(job.id, 'completed', {
      questionCount: questions.length,
      pageRange: `${startPage}-${endPage}`,
      format: format,
      completedAt: new Date().toISOString()
    });

    console.log(`Job ${job.id} completed: Extracted ${questions.length} questions`);
  } catch (error) {
    console.error(`Job ${job.id} failed: ${error.message}`);
    
    await updateJobStatus(job.id, 'failed', {
      error: error.message,
      failedAt: new Date().toISOString()
    });
  }
}

/**
 * Update job status with retry mechanism
 */
async function updateJobStatus(jobId, status, logs = {}) {
  const MAX_RETRIES = 3;
  let attempt = 0;
  
  while (attempt < MAX_RETRIES) {
    try {
      // Get current logs to merge with new logs
      const { data: currentJob, error: fetchError } = await supabase
        .from('parsestart')
        .select('logs')
        .eq('id', jobId)
        .single();
        
      if (fetchError) {
        throw new Error(`Failed to fetch job: ${fetchError.message}`);
      }

      // Merge logs
      const currentLogs = currentJob?.logs || {};
      const updatedLogs = { 
        ...currentLogs, 
        ...logs, 
        lastUpdated: new Date().toISOString() 
      };

      // Update job status
      const { error: updateError } = await supabase
        .from('parsestart')
        .update({ 
          status: status, 
          logs: updatedLogs,
          updated_at: new Date().toISOString()
        })
        .eq('id', jobId);
        
      if (updateError) {
        throw new Error(`Failed to update job: ${updateError.message}`);
      }
      
      return; // Success
    } catch (error) {
      attempt++;
      console.error(`Error updating job status (attempt ${attempt}): ${error.message}`);
      
      if (attempt >= MAX_RETRIES) {
        console.error(`Failed to update job ${jobId} after ${MAX_RETRIES} attempts`);
        break;
      }
      
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
}

/**
 * Check for pending jobs and process them
 */
async function checkPendingJobs() {
  try {
    const { data: pendingJobs, error } = await supabase
      .from('parsestart')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) {
      throw new Error(`Error fetching pending jobs: ${error.message}`);
    }

    if (pendingJobs && pendingJobs.length > 0) {
      await processJob(pendingJobs[0]);
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
    
    if (!bookName || isNaN(startPage) || isNaN(endPage) || startPage >= endPage) {
      return res.status(400).json({ 
        error: 'Invalid parameters', 
        message: 'Please provide valid book name, start page, and end page' 
      });
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
      jobId: data[0].id,
      status: "pending",
      book: bookName,
      range: `${startPage}-${endPage}`
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Job status endpoint
app.get("/job/:id", async (req, res) => {
  try {
    const { id } = req.params;
    
    if (!id) {
      return res.status(400).json({ error: 'Job ID is required' });
    }
    
    const { data, error } = await supabase
      .from('parsestart')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Job not found' });
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get chapters from a book
app.get("/chapters", async (req, res) => {
  try {
    const bookName = req.query.book;
    
    if (!bookName) {
      return res.status(400).json({ error: 'Book name is required' });
    }
    
    const { data, error } = await supabase
      .from('quiz_questions')
      .select('chapter, chapter_index')
      .eq('bookname', bookName)
      .order('chapter_index', { ascending: true });
    
    if (error) {
      return res.status(400).json({ error: error.message });
    }
    
    // Get unique chapters
    const uniqueChapters = Array.from(new Set(data.map(item => 
      JSON.stringify({chapter: item.chapter, chapter_index: item.chapter_index})
    ))).map(item => JSON.parse(item));
    
    return res.status(200).json(uniqueChapters);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  
  // Start job processor
  checkPendingJobs();
  setInterval(checkPendingJobs, 60000);
});

export { app, processJob };
