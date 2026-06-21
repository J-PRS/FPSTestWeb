import { Color, LinesRenderBehavior, Vector2 } from "sprunk-engine";

export class GridRenderBehavior extends LinesRenderBehavior {
  constructor(gridSize: number, gridStep: number, color: Color) {
    const vertices: Vector2[] = [new Vector2(-gridSize, -gridSize)];

    for (let x = -gridSize; x <= gridSize; x += gridStep) {
      vertices.push(new Vector2(x, -gridSize));
      vertices.push(new Vector2(x, gridSize));
      vertices.push(new Vector2(x + gridStep, gridSize));
    }

    for (let y = -gridSize; y <= gridSize; y += gridStep) {
      vertices.push(new Vector2(-gridSize, y));
      vertices.push(new Vector2(gridSize, y));
      vertices.push(new Vector2(gridSize, y + gridStep));
    }
    vertices.push(new Vector2(gridSize, gridSize));
    vertices.push(new Vector2(gridSize, -gridSize));
    vertices.push(new Vector2(-gridSize, -gridSize));

    super(vertices, color);
  }
}
