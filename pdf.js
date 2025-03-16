import fs from "fs";
import pdfParse from "pdf-parse";
import natural from "natural";
import { PDFDocument } from "pdf-lib";

/**
 * Main function to extract multiple-choice questions from medical textbooks
 * @param {string} text - Extracted text from PDF
 * @param {string} formatType - Detected format type (pretest, schwartz, virgilio, etc.)
 * @param {Object} metadata - Additional extraction metadata
 * @returns {Array} - Array of extracted questions with options and answers
 */
export function extractQuestions(text, formatType = 'standard', metadata = {}) {
  try {
    console.log(`Extracting questions using ${formatType} format parser`);
    
    // Data validation
    if (!text || typeof text !== 'string') {
      console.error("Invalid text input: Text must be a non-empty string");
      return [];
    }
    
    // Clean and normalize text
    text = cleanText(text);
    
    // Auto-detect format if not specified
    if (formatType === 'standard' || formatType === 'auto') {
      formatType = detectFormatType(text);
      console.log(`Format auto-detection determined: ${formatType}`);
    }
    
    // Apply appropriate parser
    let questions = [];
    switch (formatType.toLowerCase()) {
      case 'pretest':
        questions = parsePreTestFormat(text);
        break;
      case 'schwartz':
        questions = parseSchwartzFormat(text);
        break;
      case 'virgilio':
        questions = parseVirgilioFormat(text);
        break;
      case 'getthrough':
        questions = parseGetThroughFormat(text);
        break;
      case 'rush':
        questions = parseRushFormat(text);
        break;
      default:
        // Try all parsers and use the one that finds the most questions
        questions = findBestParser(text);
    }
    
    // Check for incomplete questions and suggest page range adjustment
    const { validQuestions, incompleteQuestions } = validateQuestions(questions, metadata);
    
    if (incompleteQuestions.length > 0) {
      console.log(`Detected ${incompleteQuestions.length} potentially incomplete questions`);
      // Store incomplete questions for later completion
      saveIncompleteQuestions(incompleteQuestions, metadata.bookName);
      
      // Set suggested next range if this was a paginated extraction
      if (metadata.currentPageRange) {
        const [startPage, endPage] = metadata.currentPageRange;
        const suggestedEndPage = Math.min(endPage + 5, metadata.totalPages || endPage + 5);
        metadata.suggestedNextRange = [startPage, suggestedEndPage];
        console.log(`Suggesting expanded page range: ${startPage}-${suggestedEndPage}`);
      }
    }
    
    console.log(`Successfully extracted ${validQuestions.length} complete questions`);
    return validQuestions;
  } catch (error) {
    console.error(`Error extracting questions: ${error.message}`);
    return [];
  }
}

/**
 * Clean and normalize text for consistent parsing
 */
function cleanText(text) {
  return text
    .replace(/\r\n/g, '\n')          // Normalize line breaks
    .replace(/\[object Object\]/g, '') // Remove object placeholders
    .replace(/\t/g, ' ')             // Replace tabs with spaces
    .replace(/\n{3,}/g, '\n\n')      // Normalize multiple blank lines
    .replace(/\s{2,}/g, ' ')         // Replace multiple spaces with single space
    .replace(/\n\s+/g, '\n')         // Remove leading spaces after line breaks
    .replace(/\f/g, '\n\n');         // Replace form feeds with double line breaks
}

/**
 * Detect textbook format based on content analysis
 */
function detectFormatType(text) {
  // Pattern matching for different formats
  const formatScores = {
    pretest: 0,
    virgilio: 0,
    schwartz: 0,
    getthrough: 0,
    rush: 0
  };
  
  // PreTest format markers
  if (text.includes('PreTest') || 
      text.includes('Self-Assessment and Review') || 
      text.match(/\d+\.\s+The answer is [A-E]\./i)) {
    formatScores.pretest += 5;
  }
  if (text.match(/^\d+\.\s+.+\n\s*a\.\s+.+\n\s*b\.\s+.+\n\s*c\.\s+.+\n\s*d\.\s+.+/m)) {
    formatScores.pretest += 3;
  }
  
  // Virgilio format markers
  if (text.includes('Review of Surgery for ABSITE and Boards') ||
      text.includes('de Virgilio') ||
      text.match(/ANSWERS\s+\d+\.\s+[A-E]\./)) {
    formatScores.virgilio += 5;
  }
  if (text.match(/^\d+\.\s+.+\n\s*A\.\s+.+\n\s*B\.\s+.+\n\s*C\.\s+.+\n\s*D\.\s+.+/m)) {
    formatScores.virgilio += 3;
  }
  
  // Schwartz format markers
  if (text.includes('Schwartz') || 
      text.includes('Principles of Surgery') ||
      text.match(/Answer:\s+[A-E]/i)) {
    formatScores.schwartz += 5;
  }
  
  // Get Through SBAs format markers
  if (text.includes('Get Through SBAs') ||
      text.match(/Question\s+\d+/i)) {
    formatScores.getthrough += 5;
  }
  
  // Rush format markers
  if (text.includes('Rush University') ||
      text.includes('surgerybook')) {
    formatScores.rush += 5;
  }
  
  // Find format with highest score
  const bestFormat = Object.entries(formatScores)
    .reduce((best, [format, score]) => 
      score > best.score ? {format, score} : best, 
      {format: 'standard', score: 0}
    );
    
  return bestFormat.format;
}

/**
 * Try all parsers and return results from the most effective one
 */
function findBestParser(text) {
  const parsers = [
    { name: 'PreTest', fn: parsePreTestFormat },
    { name: 'Virgilio', fn: parseVirgilioFormat },
    { name: 'Schwartz', fn: parseSchwartzFormat },
    { name: 'GetThrough', fn: parseGetThroughFormat },
    { name: 'Generic', fn: parseGenericFormat }
  ];
  
  let bestResult = [];
  let bestScore = 0;
  
  for (const parser of parsers) {
    try {
      console.log(`Trying ${parser.name} parser...`);
      const result = parser.fn(text);
      const score = assessParsingQuality(result);
      
      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
        console.log(`${parser.name} parser: ${result.length} questions, quality score ${score.toFixed(2)}`);
      }
    } catch (error) {
      console.warn(`${parser.name} parser failed: ${error.message}`);
    }
  }
  
  return bestResult;
}

/**
 * Calculate quality score for parsed questions
 */
function assessParsingQuality(questions) {
  if (!questions.length) return 0;
  
  let score = questions.length * 10; // Base score from question count
  
  // Check question completeness
  const hasOptions = questions.filter(q => 
    q.options && Object.keys(q.options).length >= 3
  ).length;
  
  const hasAnswers = questions.filter(q => 
    q.correct_answer && q.correct_answer.trim() !== ''
  ).length;
  
  const hasExplanations = questions.filter(q => 
    q.answer_details && q.answer_details.length > 30
  ).length;
  
  // Calculate weighted score
  score += (hasOptions / questions.length) * 50;
  score += (hasAnswers / questions.length) * 30;
  score += (hasExplanations / questions.length) * 20;
  
  return score;
}

/**
 * Parse questions in PreTest format
 */
function parsePreTestFormat(text) {
  const questions = [];
  const lines = text.split('\n').filter(line => line.trim());
  
  // Find answers section
  const answerSectionIdx = findAnswerSection(lines);
  let answerMap = {};
  
  // First pass: Extract answers and explanations if answers section exists
  if (answerSectionIdx > 0) {
    answerMap = extractAnswersFromSection(lines.slice(answerSectionIdx));
  }
  
  // Second pass: Process questions and options
  let currentQuestion = null;
  
  for (let i = 0; i < (answerSectionIdx > 0 ? answerSectionIdx : lines.length); i++) {
    const line = lines[i].trim();
    
    // Look for new question (numbered)
    const questionMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (questionMatch && !line.match(/^[a-eA-E]\.\s+/)) {
      // Save previous question if it exists
      if (currentQuestion) {
        questions.push(currentQuestion);
      }
      
      const questionId = questionMatch[1];
      currentQuestion = {
        id: questionId,
        question: questionMatch[2],
        options: {},
        correct_answer: answerMap[questionId]?.answer || '',
        answer_details: answerMap[questionId]?.explanation || ''
      };
    }
    // Look for options (a., b., etc.)
    else if (currentQuestion && line.match(/^[a-eA-E]\.\s+/)) {
      const optionMatch = line.match(/^([a-eA-E])\.\s+(.+)/);
      if (optionMatch) {
        const letter = optionMatch[1].toUpperCase();
        currentQuestion.options[letter] = optionMatch[2];
      }
    }
    // If not a new question or option, append to current question text
    else if (currentQuestion && Object.keys(currentQuestion.options).length === 0) {
      currentQuestion.question += ' ' + line;
    }
  }
  
  // Add the last question
  if (currentQuestion) {
    questions.push(currentQuestion);
  }
  
  return questions;
}

/**
 * Find the beginning of the answers section
 */
function findAnswerSection(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Look for "Answers" heading
    if (line.match(/^(Answers|ANSWERS|Answers and Explanations)$/i)) {
      return i;
    }
    // Alternative format: "1. The answer is A."
    if (line.match(/^\d+\.\s+The answer is [A-E]\./i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Extract answers and explanations from the answers section
 */
function extractAnswersFromSection(lines) {
  const answerMap = {};
  let currentId = null;
  let currentAnswer = '';
  let currentExplanation = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Look for answer pattern like "1. The answer is A."
    const answerMatch = line.match(/^(\d+)\.\s+The answer is ([A-E])\.\s*(.*)/i);
    if (answerMatch) {
      // Save previous answer if exists
      if (currentId) {
        answerMap[currentId] = {
          answer: currentAnswer,
          explanation: currentExplanation.trim()
        };
      }
      
      // Start new answer
      currentId = answerMatch[1];
      currentAnswer = answerMatch[2].toUpperCase();
      currentExplanation = answerMatch[3] || '';
    }
    // Continue collecting explanation
    else if (currentId) {
      // Check if this is a new answer entry
      if (line.match(/^\d+\.\s+The answer is/i)) {
        i--; // Back up one line to process this as a new answer
        continue;
      }
      currentExplanation += ' ' + line;
    }
  }
  
  // Save the last answer
  if (currentId) {
    answerMap[currentId] = {
      answer: currentAnswer,
      explanation: currentExplanation.trim()
    };
  }
  
  return answerMap;
}

/**
 * Parse questions in Virgilio format
 */
function parseVirgilioFormat(text) {
  const questions = [];
  const lines = text.split('\n').filter(line => line.trim());
  
  // Find answers section
  const answerSectionIdx = findVirgilioAnswerSection(lines);
  let answerMap = {};
  
  // First pass: Process answers section
  if (answerSectionIdx > 0) {
    for (let i = answerSectionIdx; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Look for answer pattern (e.g., "1. A.")
      const answerMatch = line.match(/^(\d+)\.\s+([A-E])\./i);
      if (answerMatch) {
        const questionId = answerMatch[1];
        const answer = answerMatch[2].toUpperCase();
        
        // Collect explanation text
        let explanation = line.replace(/^\d+\.\s+[A-E]\.\s*/i, '');
        let j = i + 1;
        while (j < lines.length && !lines[j].match(/^\d+\.\s+[A-E]\./i)) {
          explanation += ' ' + lines[j].trim();
          j++;
        }
        
        answerMap[questionId] = {
          answer,
          explanation: explanation.trim()
        };
      }
    }
  }
  
  // Second pass: Process questions
  let currentQuestion = null;
  
  for (let i = 0; i < (answerSectionIdx > 0 ? answerSectionIdx : lines.length); i++) {
    const line = lines[i].trim();
    
    // Check for new question
    const questionMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (questionMatch && !line.match(/^[A-E]\.\s+/)) {
      // Save previous question
      if (currentQuestion) {
        questions.push(currentQuestion);
      }
      
      const questionId = questionMatch[1];
      currentQuestion = {
        id: questionId,
        question: questionMatch[2],
        options: {},
        correct_answer: answerMap[questionId]?.answer || '',
        answer_details: answerMap[questionId]?.explanation || ''
      };
    }
    // Check for options
    else if (currentQuestion && line.match(/^[A-E]\.\s+/)) {
      const optionMatch = line.match(/^([A-E])\.\s+(.+)/);
      if (optionMatch) {
        currentQuestion.options[optionMatch[1]] = optionMatch[2];
      }
    }
    // Append to question text if needed
    else if (currentQuestion && Object.keys(currentQuestion.options).length === 0) {
      currentQuestion.question += ' ' + line;
    }
  }
  
  // Add the last question
  if (currentQuestion) {
    questions.push(currentQuestion);
  }
  
  return questions;
}

/**
 * Find answer section in Virgilio format
 */
function findVirgilioAnswerSection(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // Look for answers heading
    if (line.match(/^(ANSWERS|Answers|Answer Key)$/i)) {
      return i;
    }
    // Look for first numbered answer with letter
    if (line.match(/^\d+\.\s+[A-E]\./i)) {
      return i;
    }
  }
  return -1;
}

/**
 * Parse questions in Schwartz format
 */
function parseSchwartzFormat(text) {
  const questions = [];
  const lines = text.split('\n').filter(line => line.trim());
  
  let currentQuestion = null;
  let inExplanation = false;
  let explanationText = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Check for new question
    const questionMatch = line.match(/^(\d+)\.\s+(.+)/);
    if (questionMatch && !line.match(/^[A-E]\.\s+/)) {
      // Save previous question
      if (currentQuestion) {
        if (explanationText) {
          currentQuestion.answer_details = explanationText.trim();
        }
        questions.push(currentQuestion);
      }
      
      // Start new question
      currentQuestion = {
        id: questionMatch[1],
        question: questionMatch[2],
        options: {},
        correct_answer: '',
        answer_details: ''
      };
      inExplanation = false;
      explanationText = '';
    }
    // Check for options
    else if (currentQuestion && line.match(/^[A-E]\.\s+/)) {
      const optionMatch = line.match(/^([A-E])\.\s+(.+)/);
      if (optionMatch) {
        currentQuestion.options[optionMatch[1]] = optionMatch[2];
      }
    }
    // Check for answer marker
    else if (currentQuestion && line.match(/^(Answer|Answer:)\s+[A-E]/i)) {
      const answerMatch = line.match(/^(Answer|Answer:)\s+([A-E])/i);
      if (answerMatch) {
        currentQuestion.correct_answer = answerMatch[2];
        inExplanation = true;
        explanationText = line.replace(/^(Answer|Answer:)\s+[A-E][.:]\s*/i, '');
      }
    }
    // Collect explanation text
    else if (inExplanation) {
      explanationText += ' ' + line;
    }
    // Continue question text
    else if (currentQuestion && Object.keys(currentQuestion.options).length === 0) {
      currentQuestion.question += ' ' + line;
    }
  }
  
  // Add the last question
  if (currentQuestion) {
    if (explanationText) {
      currentQuestion.answer_details = explanationText.trim();
    }
    questions.push(currentQuestion);
  }
  
  return questions;
}

/**
 * Generic parser for other formats (Get Through SBAs, Rush, etc.)
 */
function parseGenericFormat(text) {
  const questions = [];
  const lines = text.split('\n').filter(line => line.trim());
  
  let currentQuestion = null;
  let inExplanation = false;
  let explanationText = '';
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Find question patterns (very flexible)
    const questionMatch = line.match(/^(?:Question\s+)?(\d+)\.?\s+(.+)/i);
    if (questionMatch && !line.match(/^[a-eA-E][.)]\s+/i)) {
      // Save previous question
      if (currentQuestion) {
        if (explanationText) {
          currentQuestion.answer_details = explanationText.trim();
        }
        questions.push(currentQuestion);
      }
      
      // Start new question
      currentQuestion = {
        id: questionMatch[1],
        question: questionMatch[2],
        options: {},
        correct_answer: '',
        answer_details: ''
      };
      inExplanation = false;
      explanationText = '';
    }
    // Look for option patterns (A., a., A), a), etc.)
    else if (currentQuestion && line.match(/^[a-eA-E][.)]\s+/i)) {
      const optionMatch = line.match(/^([a-eA-E])[.)]\s+(.+)/i);
      if (optionMatch) {
        const letter = optionMatch[1].toUpperCase();
        currentQuestion.options[letter] = optionMatch[2];
      }
    }
    // Look for answer patterns
    else if (currentQuestion && line.match(/(?:answer|correct)(?:\s+is)?:?\s+[a-eA-E]/i)) {
      const answerMatch = line.match(/(?:answer|correct)(?:\s+is)?:?\s+([a-eA-E])/i);
      if (answerMatch) {
        currentQuestion.correct_answer = answerMatch[1].toUpperCase();
        inExplanation = true;
        explanationText = line.replace(/.*(?:answer|correct)(?:\s+is)?:?\s+[a-eA-E][.):]?\s*/i, '');
      }
    }
    // Look for explanation sections
    else if (currentQuestion && line.match(/^(explanation|discussion):/i) && !inExplanation) {
      inExplanation = true;
      explanationText = line.replace(/^(explanation|discussion):?\s*/i, '');
    }
    // Continue collecting explanation
    else if (inExplanation) {
      explanationText += ' ' + line;
    }
    // Append to question text
    else if (currentQuestion && Object.keys(currentQuestion.options).length === 0) {
      currentQuestion.question += ' ' + line;
    }
  }
  
  // Add the last question
  if (currentQuestion) {
    if (explanationText) {
      currentQuestion.answer_details = explanationText.trim();
    }
    questions.push(currentQuestion);
  }
  
  return questions;
}

/**
 * Parse questions in Get Through SBAs format
 */
function parseGetThroughFormat(text) {
  return parseGenericFormat(text);
}

/**
 * Parse questions in Rush format
 */
function parseRushFormat(text) {
  return parseGenericFormat(text);
}

/**
 * Validate questions and identify incomplete ones
 */
function validateQuestions(questions, metadata) {
  const validQuestions = [];
  const incompleteQuestions = [];
  
  for (const question of questions) {
    // Skip questions with no question text or ID
    if (!question.id || !question.question || question.question.length < 10) {
      continue;
    }
    
    // Check for potentially incomplete questions
    let isIncomplete = false;
    
    // Check for missing options
    const options = question.options || {};
    const optionKeys = Object.keys(options).map(k => k.toUpperCase()).sort();
    
    if (optionKeys.length < 2) {
      isIncomplete = true;
    } else {
      // Check for sequential options (A,B,C,D,E)
      const expectedKeys = Array.from({ length: optionKeys.length }, 
        (_, i) => String.fromCharCode(65 + i));
      
      if (!expectedKeys.every(k => optionKeys.includes(k))) {
        isIncomplete = true;
      }
    }
    
    // Check for truncated text in last option
    if (optionKeys.length > 0) {
      const lastKey = optionKeys[optionKeys.length - 1];
      const lastOption = options[lastKey];
      
      if (lastOption && !lastOption.match(/[.?!:;]$/)) {
        isIncomplete = true;
      }
    }
    
    // Check if this is one of the last questions in the range and has missing answer
    if (question.correct_answer && !question.answer_details) {
      // If answer is known but explanation is missing
      isIncomplete = true;
    }
    
    // Add to appropriate list
    if (isIncomplete && questions.indexOf(question) >= questions.length - 3) {
      incompleteQuestions.push(question);
    } else {
      validQuestions.push(question);
    }
  }
  
  return { validQuestions, incompleteQuestions };
}

/**
 * Save incomplete questions for later completion
 */
function saveIncompleteQuestions(questions, bookName) {
  if (!questions.length) return;
  
  const filename = `incomplete_questions_${bookName ? bookName.replace(/\s+/g, '_') : 'unknown'}.json`;
  
  try {
    // Read existing file if it exists
    let existingQuestions = [];
    if (fs.existsSync(filename)) {
      existingQuestions = JSON.parse(fs.readFileSync(filename, 'utf8'));
    }
    
    // Merge and save
    const allQuestions = [...existingQuestions, ...questions];
    fs.writeFileSync(filename, JSON.stringify(allQuestions, null, 2));
    console.log(`Saved ${questions.length} incomplete questions to ${filename}`);
  } catch (error) {
    console.warn(`Failed to save incomplete questions: ${error.message}`);
  }
}

/**
 * Automatically extend page range to capture complete questions
 * @param {string} pdfPath - Path to the PDF file
 * @param {Array} currentRange - Current page range [start, end]
 * @param {Object} options - Additional options
 * @returns {Promise<Array>} - Optimal page range
 */
export async function findOptimalPageRange(pdfPath, currentRange, options = {}) {
  try {
    const [startPage, endPage] = currentRange;
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const totalPages = pdfDoc.getPageCount();
    
    // Don't exceed total pages
    if (endPage >= totalPages) {
      return [startPage, totalPages];
    }
    
    // Extract text from current range plus a few more pages
    const extendedEndPage = Math.min(endPage + 3, totalPages);
    const currentText = await extractPdfTextRange(pdfPath, startPage, endPage);
    const extendedText = await extractPdfTextRange(pdfPath, endPage + 1, extendedEndPage);
    
    // Check if there are interrupted questions or answers
    const currentQuestions = extractQuestions(currentText, 'auto', { 
      bookName: options.bookName || 'unknown', 
      currentPageRange: [startPage, endPage], 
      totalPages 
    });
    
    const { incompleteQuestions } = validateQuestions(currentQuestions, {});
    
    // If we have incomplete questions, check extended text for completions
    if (incompleteQuestions.length > 0) {
      const lookForCompletions = incompleteQuestions.map(q => {
        // Generate search patterns from question ID and first few words
        const questionId = q.id;
        const questionWords = q.question.split(' ').slice(0, 3).join(' ');
        return { id: questionId, searchPattern: questionWords };
      });
      
      // Check if extended text contains completions
      const hasCompletions = lookForCompletions.some(item => 
        extendedText.includes(item.id) || 
        extendedText.includes(item.searchPattern)
      );
      
      if (hasCompletions) {
        console.log(`Extended range needed: Found completions in pages ${endPage+1}-${extendedEndPage}`);
        return [startPage, extendedEndPage];
      }
    }
    
    // Check if extended text contains answer section
    if (extendedText.match(/^\s*(ANSWERS|Answers|Answer Key|The answer is)/im)) {
      console.log(`Extended range needed: Found answers section in pages ${endPage+1}-${extendedEndPage}`);
      return [startPage, extendedEndPage];
    }
    
    // No need to extend
    return currentRange;
  } catch (error) {
    console.error(`Error finding optimal page range: ${error.message}`);
    return currentRange; // Return original range on error
  }
}

/**
 * Extract text from specific PDF page range
 * @param {string} pdfPath - Path to PDF file
 * @param {number} startPage - Starting page (1-based)
 * @param {number} endPage - Ending page (1-based) 
 * @returns {Promise<string>} - Extracted text
 */
async function extractPdfTextRange(pdfPath, startPage, endPage) {
  try {
    const pdfBytes = fs.readFileSync(pdfPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    
    // Create new PDF with just the specified pages
    const newPdf = await PDFDocument.create();
    
    // Convert to 0-based indexing
    const pageIndices = Array.from(
      { length: endPage - startPage + 1 },
      (_, i) => startPage + i - 1
    );
    
    // Copy pages to new PDF
    for (const pageIndex of pageIndices) {
      if (pageIndex < pdfDoc.getPageCount()) {
        const [copiedPage] = await newPdf.copyPages(pdfDoc, [pageIndex]);
        newPdf.addPage(copiedPage);
      }
    }
    
    // Save new PDF as buffer
    const extractedPdfBytes = await newPdf.save();
    
    // Parse text from the extracted pages
    const data = await pdfParse(extractedPdfBytes);
    return data.text;
  } catch (error) {
    console.error(`Error extracting text from page range: ${error.message}`);
    return '';
  }
}

/**
 * Format questions for database insertion
 * @param {Array} questions - Extracted questions
 * @param {string} bookname - Name of the book
 * @returns {Array} - Formatted questions for database
 */
export function formatQuestionsForDB(questions, bookname) {
  return questions.map(q => ({
    question: q.question,
    options: q.options,
    correct_answer: q.correct_answer,
    answer_details: q.answer_details,
    bookname: bookname,
    active: true
  }));
}

/**
 * Intelligently merge questions across page boundaries
 * Useful for completing questions that were cut off
 * @param {Array} questions1 - First set of questions
 * @param {Array} questions2 - Second set of questions 
 * @returns {Array} - Merged questions
 */
export function mergeQuestions(questions1, questions2) {
  if (!questions1.length) return questions2;
  if (!questions2.length) return questions1;
  
  const merged = [...questions1];
  const idMap = new Map(questions1.map(q => [q.id, true]));
  
  // Add new questions from the second set
  for (const q2 of questions2) {
    if (!idMap.has(q2.id)) {
      merged.push(q2);
      continue;
    }
    
    // Get the existing question
    const existingIndex = merged.findIndex(q => q.id === q2.id);
    const existing = merged[existingIndex];
    
    // Merge question text if needed
    if (q2.question.length > existing.question.length) {
      merged[existingIndex].question = q2.question;
    }
    
    // Merge options
    const mergedOptions = {...existing.options};
    for (const [key, value] of Object.entries(q2.options)) {
      if (!mergedOptions[key] || value.length > mergedOptions[key].length) {
        mergedOptions[key] = value;
      }
    }
    merged[existingIndex].options = mergedOptions;
    
    // Use the answer if available
    if (q2.correct_answer && !existing.correct_answer) {
      merged[existingIndex].correct_answer = q2.correct_answer;
    }
    
    // Merge answer details
    if (q2.answer_details && q2.answer_details.length > (existing.answer_details?.length || 0)) {
      merged[existingIndex].answer_details = q2.answer_details;
    }
  }
  
  return merged;
}

/**
 * Save extracted questions to file
 * @param {Array} questions - Extracted questions
 * @param {string} filename - Output filename
 */
export function saveExtractedQuestions(questions, filename = "extractedQuestions.json") {
  try {
    fs.writeFileSync(filename, JSON.stringify(questions, null, 2));
    console.log(`Saved ${questions.length} questions to ${filename}`);
  } catch (error) {
    console.error(`Error saving questions: ${error.message}`);
  }
}
