import express, { Request, Response } from 'express';
import { Firestore } from '@google-cloud/firestore';
import { GoogleGenerativeAI } from '@google/generative-ai';

const app = express();
const PORT = process.env.PORT || 8082;

const firestore = new Firestore({
  ignoreUndefinedProperties: true
});

// Initialize Gemini AI
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

console.log('✓ Gemini API key configured');

const genAI = new GoogleGenerativeAI(apiKey);
const model = genAI.getGenerativeModel({ 
  model: 'gemini-1.5-flash',
  generationConfig: {
    temperature: 0.7,
    topK: 40,
    topP: 0.95,
    maxOutputTokens: 1024,
  }
});

app.use(express.json());

interface Review {
  reviewId: string;
  productId: string;
  rating: number;
  reviewText: string;
  reviewerName?: string;
  reviewerEmail?: string;
  timestamp: string;
}

interface GeminiAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  sentimentScore: number;
  keyTopics: string[];
  summary: string;
  emotions: string[];
  actionableInsights: string[];
}

interface AnalysisResult extends GeminiAnalysis {
  reviewId: string;
  productId: string;
  processingTime: number;
  analyzedAt: string;
}

// Analyze review with Gemini
async function analyzeWithGemini(reviewText: string, rating: number): Promise<GeminiAnalysis> {
  const prompt = `
You are an expert product review analyst. Analyze the following product review and provide structured insights.

Review Text: "${reviewText}"
Rating: ${rating}/5 stars

Provide a comprehensive analysis in the following JSON format (respond ONLY with valid JSON, no markdown):

{
  "sentiment": "positive|negative|neutral",
  "sentimentScore": <number between 0-100>,
  "keyTopics": ["topic1", "topic2", "topic3"],
  "summary": "A concise 1-2 sentence summary",
  "emotions": ["emotion1", "emotion2"],
  "actionableInsights": ["insight1", "insight2", "insight3"]
}

Guidelines:
- sentiment: Overall feeling (positive/negative/neutral)
- sentimentScore: 0=very negative, 50=neutral, 100=very positive
- keyTopics: Main subjects discussed (quality, delivery, price, customer service, etc.)
- summary: Brief overview of the review
- emotions: Emotional states detected (happy, frustrated, satisfied, disappointed, excited, angry, etc.)
- actionableInsights: Specific recommendations for product/service improvement

Respond with ONLY the JSON object, no additional text.
`;

  try {
    console.log('📞 Calling Gemini API...');
    const result = await model.generateContent(prompt);
    const response = result.response.text();
    
    console.log('✓ Gemini response received');
    
    // Remove markdown code blocks if present
    let cleanedResponse = response.trim();
    if (cleanedResponse.startsWith('```json')) {
      cleanedResponse = cleanedResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '');
    } else if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/```\n?/g, '');
    }
    
    // Extract JSON object
    const jsonMatch = cleanedResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON object found in Gemini response');
    }
    
    const analysis: GeminiAnalysis = JSON.parse(jsonMatch[0]);
    
    // Validate the response structure
    if (!analysis.sentiment || !analysis.keyTopics || !analysis.summary) {
      throw new Error('Invalid analysis structure from Gemini');
    }
    
    console.log(`✓ Analysis completed: ${analysis.sentiment} (${analysis.sentimentScore})`);
    return analysis;
  } catch (error) {
    console.error('❌ Gemini analysis failed:', error);
    
    // Fallback analysis
    return {
      sentiment: rating >= 4 ? 'positive' : rating <= 2 ? 'negative' : 'neutral',
      sentimentScore: rating * 20,
      keyTopics: ['general feedback'],
      summary: `Customer provided a ${rating}-star review.`,
      emotions: rating >= 4 ? ['satisfied'] : ['disappointed'],
      actionableInsights: ['Review requires manual analysis']
    };
  }
}

// Update product analytics
async function updateProductAnalytics(productId: string, result: AnalysisResult): Promise<void> {
  console.log(`Updating analytics for product: ${productId}`);
  const productRef = firestore.collection('product-analytics').doc(productId);
  
  await firestore.runTransaction(async (transaction) => {
    const doc = await transaction.get(productRef);
    
    if (!doc.exists) {
      console.log(`Creating new product analytics for: ${productId}`);
      transaction.set(productRef, {
        productId,
        totalReviews: 1,
        sentimentDistribution: {
          positive: result.sentiment === 'positive' ? 1 : 0,
          negative: result.sentiment === 'negative' ? 1 : 0,
          neutral: result.sentiment === 'neutral' ? 1 : 0
        },
        averageSentimentScore: result.sentimentScore,
        topTopics: result.keyTopics,
        commonEmotions: result.emotions,
        lastUpdated: new Date().toISOString(),
        createdAt: new Date().toISOString()
      });
    } else {
      console.log(`Updating existing product analytics for: ${productId}`);
      const data = doc.data()!;
      const totalReviews = (data.totalReviews || 0) + 1;
      
      transaction.update(productRef, {
        totalReviews,
        sentimentDistribution: {
          positive: (data.sentimentDistribution?.positive || 0) + (result.sentiment === 'positive' ? 1 : 0),
          negative: (data.sentimentDistribution?.negative || 0) + (result.sentiment === 'negative' ? 1 : 0),
          neutral: (data.sentimentDistribution?.neutral || 0) + (result.sentiment === 'neutral' ? 1 : 0)
        },
        averageSentimentScore: 
          ((data.averageSentimentScore || 0) * (data.totalReviews || 0) + result.sentimentScore) / totalReviews,
        lastUpdated: new Date().toISOString()
      });
    }
  });
  
  console.log(`✓ Analytics updated for product: ${productId}`);
}

// Process review
async function processReviewData(review: Review): Promise<void> {
  const startTime = Date.now();
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔄 Processing review ${review.reviewId}`);
  console.log(`   Product: ${review.productId}`);
  console.log(`   Rating: ${review.rating}/5`);
  console.log(`   Text: ${review.reviewText.substring(0, 100)}...`);
  console.log(`${'='.repeat(60)}\n`);
  
  try {
    // Analyze with Gemini
    const analysis = await analyzeWithGemini(review.reviewText, review.rating);
    
    const processingTime = Date.now() - startTime;
    const analyzedAt = new Date().toISOString();

    const result: AnalysisResult = {
      ...analysis,
      reviewId: review.reviewId,
      productId: review.productId,
      processingTime,
      analyzedAt
    };

    // Prepare original review object, removing undefined fields
    const originalReview: any = {
      reviewText: review.reviewText,
      rating: review.rating,
      timestamp: review.timestamp
    };
    
    // Only add optional fields if they exist
    if (review.reviewerName) {
      originalReview.reviewerName = review.reviewerName;
    }
    if (review.reviewerEmail) {
      originalReview.reviewerEmail = review.reviewerEmail;
    }

    // Store analysis in Firestore
    console.log(`💾 Saving to Firestore...`);
    await firestore.collection('analyzed-reviews').doc(review.reviewId).set({
      ...result,
      originalReview
    });

    console.log(`✓ Analysis saved to Firestore`);

    // Update product analytics
    await updateProductAnalytics(review.productId, result);

    console.log(`\n✅ Review ${review.reviewId} processed successfully in ${processingTime}ms`);
    console.log(`   Sentiment: ${result.sentiment} (${result.sentimentScore}/100)`);
    console.log(`   Topics: ${result.keyTopics.join(', ')}`);
    console.log(`${'='.repeat(60)}\n`);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`\n❌ Failed to process review ${review.reviewId}:`, errorMessage);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    throw error;
  }
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    service: 'ai-analysis',
    timestamp: new Date().toISOString(),
    geminiConfigured: !!apiKey
  });
});

// Push endpoint for Pub/Sub
app.post('/process', async (req: Request, res: Response) => {
  console.log('\n📨 Received Pub/Sub push request');
  
  try {
    // Pub/Sub sends messages in this format
    const pubsubMessage = req.body.message;
    
    if (!pubsubMessage) {
      console.error('❌ No message in request body');
      return res.status(400).send('No message found');
    }
    
    if (!pubsubMessage.data) {
      console.error('❌ No data in message');
      return res.status(400).send('No data in message');
    }
    
    // Decode base64 message data
    const messageData = Buffer.from(pubsubMessage.data, 'base64').toString('utf-8');
    console.log('Decoded message data:', messageData);
    
    const review: Review = JSON.parse(messageData);
    
    // Validate review data
    if (!review.reviewId || !review.productId || !review.reviewText) {
      console.error('❌ Invalid review data:', review);
      return res.status(400).send('Invalid review data');
    }
    
    // Process the review
    await processReviewData(review);
    
    // Acknowledge the message
    res.status(200).send('OK');

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('❌ Error processing Pub/Sub message:', errorMessage);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    
    // Return 500 so Pub/Sub will retry
    res.status(500).send(`Processing failed: ${errorMessage}`);
  }
});

// Manual analysis endpoint (for testing)
app.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { reviewText, rating } = req.body;
    
    if (!reviewText || !rating) {
      return res.status(400).json({ 
        error: 'reviewText and rating are required' 
      });
    }

    const analysis = await analyzeWithGemini(reviewText, rating);
    res.json(analysis);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Analysis failed',
      message: errorMessage
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 AI Analysis Service Started`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Gemini API: Configured`);
  console.log(`   Ready to receive push messages at /process`);
  console.log(`${'='.repeat(60)}\n`);
});

process.on('SIGTERM', () => {
  console.log('\nSIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});