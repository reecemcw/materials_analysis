const Anthropic = require('@anthropic-ai/sdk');
const logger = require('./utils/logger');

class AILabeller {
  constructor() {
    this.client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
    this.model = process.env.AI_MODEL || 'claude-sonnet-4-20250514';
  }

  async labelArticle(article) {
    try {
      logger.info(`Labelling article: ${article.id}`);

      const prompt = this.buildPrompt(article);
      
      const message = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const responseText = message.content[0].text;
      const labels = this.parseLabels(responseText);

      logger.info(`Successfully labelled article: ${article.id}`);
      
      return {
        ...labels,
        labelledAt: new Date().toISOString(),
        modelUsed: this.model
      };
    } catch (error) {
      logger.error('Labelling error:', error);
      throw new Error(`Failed to label article: ${error.message}`);
    }
  }

  buildPrompt(article) {
    return `Analyze this article and provide structured metadata in JSON format.

Article Title: ${article.title}
Author: ${article.author || 'Unknown'}
Excerpt: ${article.excerpt || 'N/A'}
Content: ${article.content ? article.content.substring(0, 3000) : 'N/A'}

Please provide the following analysis in valid JSON format:
{
  "categories": ["primary category", "secondary category"],
  "topics": ["specific topic 1", "specific topic 2", "topic 3"],
  "entities": {
    "people": ["person 1", "person 2"],
    "organizations": ["org 1", "org 2"],
    "locations": ["location 1", "location 2"],
    "products": ["product 1"]
  },
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "sentiment": "positive|negative|neutral",
  "summary": "A concise 2-3 sentence summary of the article",
  "readingTime": "estimated minutes to read",
  "complexity": "beginner|intermediate|advanced",
  "contentType": "news|opinion|tutorial|research|review|analysis"
}

Respond ONLY with valid JSON, no additional text.`;
  }

  parseLabels(responseText) {
    try {
      // Try to extract JSON from the response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      
      // If no JSON found, try parsing the entire response
      return JSON.parse(responseText);
    } catch (error) {
      logger.error('Failed to parse AI response:', error);
      logger.debug('Response text:', responseText);
      
      // Return default structure if parsing fails
      return {
        categories: [],
        topics: [],
        entities: {
          people: [],
          organizations: [],
          locations: [],
          products: []
        },
        keywords: [],
        sentiment: 'neutral',
        summary: 'Failed to generate summary',
        readingTime: 'Unknown',
        complexity: 'unknown',
        contentType: 'unknown',
        parseError: true
      };
    }
  }

  async batchLabel(articles) {
    const results = [];
    
    for (const article of articles) {
      try {
        const labels = await this.labelArticle(article);
        results.push({
          success: true,
          articleId: article.id,
          labels
        });
      } catch (error) {
        results.push({
          success: false,
          articleId: article.id,
          error: error.message
        });
      }
      
      // Rate limiting - wait 1 second between requests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return results;
  }

  async generateRelationships(taggedArticle, allArticles) {
    try {
      // Simple relationship detection based on shared tags/topics
      const relationships = [];

      for (const other of allArticles) {
        if (other.id === taggedArticle.id) continue;

        const sharedTopics = taggedArticle.labels.topics.filter(
          topic => other.labels?.topics?.includes(topic)
        );

        const sharedKeywords = taggedArticle.labels.keywords.filter(
          keyword => other.labels?.keywords?.includes(keyword)
        );

        if (sharedTopics.length > 0 || sharedKeywords.length >= 2) {
          relationships.push({
            targetArticleId: other.id,
            relationshipType: 'RELATES_TO',
            strength: (sharedTopics.length * 2 + sharedKeywords.length) / 10,
            sharedTopics,
            sharedKeywords: sharedKeywords.slice(0, 5)
          });
        }
      }

      // Sort by strength and take top 5
      return relationships
        .sort((a, b) => b.strength - a.strength)
        .slice(0, 5);
    } catch (error) {
      logger.error('Failed to generate relationships:', error);
      return [];
    }
  }
}

module.exports = AILabeller;