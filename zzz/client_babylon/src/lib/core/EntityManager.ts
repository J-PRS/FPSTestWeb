import * as BABYLON from '@babylonjs/core';
import { type RigidBody } from '../customPhysics';
import type { ISystem } from './ISystem';

export interface Entity {
  id: string;
  mesh: BABYLON.Mesh;
  body?: RigidBody;
  type: 'player' | 'enemy' | 'projectile' | 'explosion';
  active: boolean;
}

export class EntityManager implements ISystem {
  private entities = new Map<string, Entity>();
  private entitiesByType = new Map<string, Set<string>>();
  public readonly updateOrder = 25; // After physics, before weapons

  addEntity(entity: Entity): void {
    this.entities.set(entity.id, entity);
    
    if (!this.entitiesByType.has(entity.type)) {
      this.entitiesByType.set(entity.type, new Set());
    }
    this.entitiesByType.get(entity.type)!.add(entity.id);
  }

  removeEntity(id: string): void {
    const entity = this.entities.get(id);
    if (!entity) return;

    // Remove from type mapping
    this.entitiesByType.get(entity.type)?.delete(id);

    // Dispose mesh and physics body
    entity.mesh.dispose();
    if (entity.body) {
      // Physics body will be removed by the respective system
    }

    // Remove from entities
    this.entities.delete(id);
  }

  getEntity(id: string): Entity | undefined {
    return this.entities.get(id);
  }

  getEntitiesByType(type: string): Entity[] {
    const ids = this.entitiesByType.get(type) || new Set();
    return Array.from(ids).map(id => this.entities.get(id)!).filter(Boolean);
  }

  getAllEntities(): Entity[] {
    return Array.from(this.entities.values());
  }

  update(dt: number): void {
    // Update all entity mesh positions to match physics bodies
    this.entities.forEach(entity => {
      if (entity.body && entity.active) {
        entity.mesh.position = entity.body.position.clone();
      }
    });
  }

  public initialize(): void {
    // EntityManager doesn't need initialization
  }

  public dispose(): void {
    this.clear();
  }

  clear(): void {
    this.entities.forEach(entity => {
      entity.mesh.dispose();
    });
    this.entities.clear();
    this.entitiesByType.clear();
  }

  generateId(type: string): string {
    return `${type}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}
