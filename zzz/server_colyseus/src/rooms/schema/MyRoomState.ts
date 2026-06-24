import { Schema, type, MapSchema } from "@colyseus/schema";

export class Player extends Schema {
  @type("float32") x: number = 0;
  @type("float32") y: number = 0;
  @type("float32") z: number = 0;
  @type("float32") yaw: number = 0;
  @type("float32") pitch: number = 0;
}

export class MyRoomState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
