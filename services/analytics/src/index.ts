import express, { Request, Response } from 'express';
import { Firestore } from '@google-cloud/firestore';
import { Logging } from '@google-cloud/logging';
import cors from 'cors';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8083;

// Initialize Google Cloud clients
const firestore = new Firestore();
const logging = new Logging();
const log = logging.log('analytics');

app.use(cors());
app.use(express.json());

interface ProductAnalytics {
  productId: string;
  totalReviews: number;
  sentimentDistribution: {
    positive: number;
    negative: number;
    neutral: number;
  };
  averageSentimentScore: number;
  topTopics?: string[];
  commonEmotions?: string[];
  lastUpdated: string;
  createdAt?: string;
}

interface AnalysisResult {
  reviewId: string;
  productId: string;
  sentiment: string;
  sentimentScore: number;
  keyTopics: string[];
  summary: string;
  emotions: string[];
  actionableInsights: string[];
  processingTime: number;
  analyzedAt: string;
  originalReview?: {
    reviewText: string;
    rating: number;
    reviewerName?: string;
    timestamp: string;
  };
}

interface TopicCount {
  topic: string;
  count: number;
}

interface AnalyticsResponse {
  productId: string;
  summary: ProductAnalytics;
  topTopics: TopicCount[];
  recentInsights: string[];
  recentReviews: AnalysisResult[];
  totalReviewsAnalyzed: number;
  sentimentTrend: {
    positivePercentage: number;
    negativePercentage: number;
    neutralPercentage: number;
  };
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    service: 'analytics',
    timestamp: new Date().toISOString()
  });
});

// Get product analytics
app.get('/analytics/:productId', async (req: Request, res: Response) => {
  const startTime = Date.now();
  
  try {
    const { productId } = req.params;
    const limit = parseInt(req.query.limit as string) || 100;

    await log.write(log.entry({
      severity: 'INFO',
      jsonPayload: {
        message: 'Fetching analytics',
        productId,
        limit
      }
    }));

    // Get product analytics summary
    const productDoc = await firestore
      .collection('product-analytics')
      .doc(productId)
      .get();

    if (!productDoc.exists) {
      await log.write(log.entry({
        severity: 'WARNING',
        jsonPayload: {
          message: 'Product not found',
          productId
        }
      }));
      
      return res.status(404).json({ 
        error: 'Product not found',
        productId,
        message: 'No reviews have been analyzed for this product yet'
      });
    }

    const summary = productDoc.data() as ProductAnalytics;

    // Get recent analyzed reviews
    const reviewsSnapshot = await firestore
      .collection('analyzed-reviews')
      .where('productId', '==', productId)
      .orderBy('analyzedAt', 'desc')
      .limit(limit)
      .get();

    const reviews: AnalysisResult[] = reviewsSnapshot.docs.map(
      doc => doc.data() as AnalysisResult
    );

    // Calculate topic frequency
    const allTopics = reviews.flatMap(r => r.keyTopics || []);
    const topicFrequency: Record<string, number> = {};
    
    allTopics.forEach(topic => {
      const normalizedTopic = topic.toLowerCase().trim();
      topicFrequency[normalizedTopic] = (topicFrequency[normalizedTopic] || 0) + 1;
    });

    const topTopics: TopicCount[] = Object.entries(topicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count }));

    // Get unique actionable insights
    const allInsights = reviews
      .flatMap(r => r.actionableInsights || [])
      .filter((insight, index, self) => self.indexOf(insight) === index)
      .slice(0, 20);

    // Calculate sentiment trend percentages
    const total = summary.totalReviews || 1;
    const sentimentTrend = {
      positivePercentage: Math.round((summary.sentimentDistribution.positive / total) * 100),
      negativePercentage: Math.round((summary.sentimentDistribution.negative / total) * 100),
      neutralPercentage: Math.round((summary.sentimentDistribution.neutral / total) * 100)
    };

    const duration = Date.now() - startTime;

    await log.write(log.entry({
      severity: 'INFO',
      jsonPayload: {
        message: 'Analytics retrieved successfully',
        productId,
        totalReviews: reviews.length,
        duration
      }
    }));

    const response: AnalyticsResponse = {
      productId,
      summary,
      topTopics,
      recentInsights: allInsights,
      recentReviews: reviews.slice(0, 10),
      totalReviewsAnalyzed: reviews.length,
      sentimentTrend
    };

    res.json(response);

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await log.write(log.entry({
      severity: 'ERROR',
      jsonPayload: {
        message: 'Failed to retrieve analytics',
        productId: req.params.productId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        duration
      }
    }));

    res.status(500).json({ 
      error: 'Failed to retrieve analytics',
      message: errorMessage
    });
  }
});

// Get specific review analysis
app.get('/review/:reviewId', async (req: Request, res: Response) => {
  try {
    const { reviewId } = req.params;

    const reviewDoc = await firestore
      .collection('analyzed-reviews')
      .doc(reviewId)
      .get();

    if (!reviewDoc.exists) {
      return res.status(404).json({ 
        error: 'Review not found',
        reviewId 
      });
    }

    res.json(reviewDoc.data());

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await log.write(log.entry({
      severity: 'ERROR',
      jsonPayload: {
        message: 'Failed to retrieve review',
        reviewId: req.params.reviewId,
        error: errorMessage
      }
    }));

    res.status(500).json({ 
      error: 'Failed to retrieve review',
      message: errorMessage
    });
  }
});

// Get all products with analytics
app.get('/products', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;

    const productsSnapshot = await firestore
      .collection('product-analytics')
      .orderBy('totalReviews', 'desc')
      .limit(limit)
      .get();

    const products = productsSnapshot.docs.map(doc => ({
      productId: doc.id,
      ...doc.data()
    }));

    res.json({
      total: products.length,
      products
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await log.write(log.entry({
      severity: 'ERROR',
      jsonPayload: {
        message: 'Failed to retrieve products',
        error: errorMessage
      }
    }));

    res.status(500).json({ 
      error: 'Failed to retrieve products',
      message: errorMessage
    });
  }
});

// Get sentiment trends over time
app.get('/trends/:productId', async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const days = parseInt(req.query.days as string) || 30;

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const reviewsSnapshot = await firestore
      .collection('analyzed-reviews')
      .where('productId', '==', productId)
      .where('analyzedAt', '>=', cutoffDate.toISOString())
      .orderBy('analyzedAt', 'asc')
      .get();

    const reviews = reviewsSnapshot.docs.map(doc => doc.data() as AnalysisResult);

    // Group by day
    const dailyTrends: Record<string, {
      date: string;
      positive: number;
      negative: number;
      neutral: number;
      averageScore: number;
      count: number;
    }> = {};

    reviews.forEach(review => {
      const date = review.analyzedAt.split('T')[0];
      
      if (!dailyTrends[date]) {
        dailyTrends[date] = {
          date,
          positive: 0,
          negative: 0,
          neutral: 0,
          averageScore: 0,
          count: 0
        };
      }

      dailyTrends[date][review.sentiment as keyof typeof dailyTrends[string]]++;
      dailyTrends[date].averageScore += review.sentimentScore;
      dailyTrends[date].count++;
    });

    // Calculate averages
    const trends = Object.values(dailyTrends).map(day => ({
      ...day,
      averageScore: day.count > 0 ? Math.round(day.averageScore / day.count) : 0
    }));

    res.json({
      productId,
      period: `${days} days`,
      trends
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await log.write(log.entry({
      severity: 'ERROR',
      jsonPayload: {
        message: 'Failed to retrieve trends',
        error: errorMessage
      }
    }));

    res.status(500).json({ 
      error: 'Failed to retrieve trends',
      message: errorMessage
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Analytics Service listening on port ${PORT}`);
});