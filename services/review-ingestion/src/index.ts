import express, { Request, Response } from 'express';
import { PubSub } from '@google-cloud/pubsub';
import { Storage } from '@google-cloud/storage';
import { Logging } from '@google-cloud/logging';
import { v4 as uuidv4 } from 'uuid';
import Joi from 'joi';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8081;

// Initialize Google Cloud clients
const pubsub = new PubSub();
const storage = new Storage();
const logging = new Logging();
const log = logging.log('review-ingestion');

const TOPIC_NAME = process.env.PUBSUB_TOPIC || 'review-submitted';
const BUCKET_NAME = process.env.REVIEW_BUCKET || 'product-reviews-raw';

app.use(express.json());

// Validation schema
const reviewSchema = Joi.object({
  productId: Joi.string().required().min(1).max(100),
  rating: Joi.number().required().min(1).max(5).integer(),
  reviewText: Joi.string().required().min(10).max(5000),
  reviewerName: Joi.string().optional().max(100),
  reviewerEmail: Joi.string().email().optional()
});

interface Review {
  productId: string;
  rating: number;
  reviewText: string;
  reviewerName?: string;
  reviewerEmail?: string;
}

interface EnrichedReview extends Review {
  reviewId: string;
  timestamp: string;
  status: 'pending';
  sourceIp?: string;
}

// Health check
app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy', 
    service: 'review-ingestion',
    timestamp: new Date().toISOString()
  });
});

// Ingest review endpoint
app.post('/ingest', async (req: Request, res: Response) => {
  const startTime = Date.now();
  let reviewId: string | undefined;
  
  try {
    // Validate request body
    const { error, value } = reviewSchema.validate(req.body);
    
    if (error) {
      await log.write(log.entry({
        severity: 'WARNING',
        jsonPayload: {
          message: 'Validation failed',
          errors: error.details.map(d => d.message)
        }
      }));
      
      return res.status(400).json({ 
        error: 'Validation failed',
        details: error.details.map(d => ({
          field: d.path.join('.'),
          message: d.message
        }))
      });
    }

    const review: Review = value;
    reviewId = uuidv4();
    const timestamp = new Date().toISOString();
    
    const enrichedReview: EnrichedReview = {
      reviewId,
      ...review,
      timestamp,
      status: 'pending',
      sourceIp: req.ip
    };

    // Store raw review in Cloud Storage
    const bucket = storage.bucket(BUCKET_NAME);
    const fileName = `reviews/${review.productId}/${reviewId}.json`;
    const file = bucket.file(fileName);
    
    await file.save(JSON.stringify(enrichedReview, null, 2), {
      contentType: 'application/json',
      metadata: {
        productId: review.productId,
        reviewId,
        timestamp,
        rating: review.rating.toString()
      }
    });

    // Publish to Pub/Sub for async processing
    const topic = pubsub.topic(TOPIC_NAME);
    const messageId = await topic.publishMessage({
      json: enrichedReview,
      attributes: {
        productId: review.productId,
        reviewId,
        timestamp
      }
    });

    const duration = Date.now() - startTime;
    
    // Log success
    await log.write(log.entry({
      severity: 'INFO',
      resource: { type: 'cloud_run_revision' },
      jsonPayload: {
        message: 'Review ingested successfully',
        reviewId,
        productId: review.productId,
        rating: review.rating,
        messageId,
        storageLocation: fileName,
        duration
      }
    }));

    res.status(201).json({
      success: true,
      reviewId,
      messageId,
      status: 'processing',
      message: 'Review submitted successfully and is being processed'
    });

  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await log.write(log.entry({
      severity: 'ERROR',
      resource: { type: 'cloud_run_revision' },
      jsonPayload: {
        message: 'Failed to ingest review',
        reviewId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        duration
      }
    }));

    res.status(500).json({ 
      error: 'Failed to ingest review',
      message: errorMessage,
      reviewId
    });
  }
});

// Get review status
app.get('/status/:reviewId', async (req: Request, res: Response) => {
  try {
    const { reviewId } = req.params;
    
    res.json({
      reviewId,
      status: 'processing',
      message: 'Check analytics service for completed analysis'
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to get review status',
      message: errorMessage
    });
  }
});

// Metrics endpoint
app.get('/metrics', async (req: Request, res: Response) => {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const [files] = await bucket.getFiles({ prefix: 'reviews/' });
    
    res.json({
      totalReviewsIngested: files.length,
      bucket: BUCKET_NAME,
      topic: TOPIC_NAME
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ 
      error: 'Failed to get metrics',
      message: errorMessage
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Review Ingestion Service listening on port ${PORT}`);
  console.log(`📦 Storage bucket: ${BUCKET_NAME}`);
  console.log(`📨 Pub/Sub topic: ${TOPIC_NAME}`);
});