import * as THREE from 'three';
import { DemoFile } from '../types/DemoFile.js';
import { DemoHeader } from '../types/DemoHeader.js';
import { DemoFrame } from '../types/DemoFrame.js';
import { ProjectileEvent } from '../types/ProjectileEvent.js';
import { TargetEvent } from '../types/TargetEvent.js';

/**
 * Demo template for quick demo creation.
 */
export interface DemoTemplate {
  /** Template ID */
  id: string;
  /** Template name */
  name: string;
  /** Description */
  description: string;
  /** Default header settings */
  header: Partial<DemoHeader>;
  /** Default frame settings */
  defaultFrame: Partial<DemoFrame>;
  /** Event presets */
  eventPresets: Array<{
    type: 'projectile' | 'target';
    eventType: number;
    delay: number;
  }>;
}

/**
 * Demo template system.
 * Pre-configured templates for common demo scenarios.
 */
export class DemoTemplate {
  private static readonly templates: Map<string, DemoTemplate> = new Map([
    [
      'quick_clip',
      {
        id: 'quick_clip',
        name: 'Quick Clip',
        description: 'Short highlight clip (10 seconds)',
        header: {
          duration: 10,
          formatVersion: 1,
          gameVersion: '1.0',
        },
        defaultFrame: {},
        eventPresets: [],
      },
    ],
    [
      'full_match',
      {
        id: 'full_match',
        name: 'Full Match',
        description: 'Complete match recording (5 minutes)',
        header: {
          duration: 300,
          formatVersion: 1,
          gameVersion: '1.0',
        },
        defaultFrame: {},
        eventPresets: [],
      },
    ],
    [
      'tutorial',
      {
        id: 'tutorial',
        name: 'Tutorial',
        description: 'Tutorial recording with high precision',
        header: {
          duration: 60,
          formatVersion: 1,
          gameVersion: '1.0',
        },
        defaultFrame: {},
        eventPresets: [],
      },
    ],
    [
      'analysis',
      {
        id: 'analysis',
        name: 'Analysis',
        description: 'High-precision recording for analysis',
        header: {
          duration: 30,
          formatVersion: 1,
          gameVersion: '1.0',
        },
        defaultFrame: {},
        eventPresets: [],
      },
    ],
  ]);

  /**
   * Get a template by ID.
   * @param id - Template ID
   * @returns Template or undefined
   */
  static getTemplate(id: string): DemoTemplate | undefined {
    return this.templates.get(id);
  }

  /**
   * Get all templates.
   * @returns Array of templates
   */
  static getAllTemplates(): DemoTemplate[] {
    return Array.from(this.templates.values());
  }

  /**
   * Create a demo file from a template.
   * @param templateId - Template ID
   * @param name - Demo name
   * @returns Demo file
   */
  static createFromTemplate(templateId: string, name: string): DemoFile {
    const template = this.templates.get(templateId);
    if (!template) {
      throw new Error(`Template not found: ${templateId}`);
    }

    const header: DemoHeader = {
      formatVersion: template.header.formatVersion || 1,
      gameVersion: template.header.gameVersion || '1.0',
      duration: template.header.duration || 30,
      totalFrames: 0,
      projectileEvents: 0,
      targetEvents: 0,
      playerStartPosition: new THREE.Vector3(0, 2, 0),
      playerStartRotation: new THREE.Quaternion(),
      playerStartVelocity: new THREE.Vector3(),
      description: name,
      checksum: 0,
      timestamp: Date.now(),
    };

    return {
      header,
      frames: [],
      projectileEvents: [],
      targetEvents: [],
      playerStartPosition: header.playerStartPosition.clone(),
      playerStartRotation: header.playerStartRotation.clone(),
      playerStartVelocity: header.playerStartVelocity.clone(),
    };
  }

  /**
   * Create a custom template.
   * @param id - Template ID
   * @param name - Template name
   * @param description - Description
   * @param header - Header settings
   * @param defaultFrame - Default frame settings
   * @param eventPresets - Event presets
   */
  static createCustomTemplate(
    id: string,
    name: string,
    description: string,
    header: Partial<DemoHeader>,
    defaultFrame: Partial<DemoFrame>,
    eventPresets: Array<{
      type: 'projectile' | 'target';
      eventType: number;
      delay: number;
    }>
  ): void {
    const template: DemoTemplate = {
      id,
      name,
      description,
      header,
      defaultFrame,
      eventPresets,
    };

    this.templates.set(id, template);
  }

  /**
   * Delete a custom template.
   * @param id - Template ID
   */
  static deleteTemplate(id: string): void {
    // Only allow deleting custom templates (not built-in ones)
    const builtInIds = ['quick_clip', 'full_match', 'tutorial', 'analysis'];
    if (!builtInIds.includes(id)) {
      this.templates.delete(id);
    }
  }

  /**
   * Export templates to JSON.
   * @returns JSON string
   */
  static exportToJSON(): string {
    const templates = this.getAllTemplates();
    return JSON.stringify(templates, null, 2);
  }

  /**
   * Import templates from JSON.
   * @param json - JSON string
   */
  static importFromJSON(json: string): void {
    try {
      const templates: DemoTemplate[] = JSON.parse(json);
      for (const template of templates) {
        this.templates.set(template.id, template);
      }
    } catch (e) {
      console.error('[DemoTemplate] Failed to import templates:', e);
    }
  }
}
