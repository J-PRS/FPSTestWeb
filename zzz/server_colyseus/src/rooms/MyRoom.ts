import { Room, Client, CloseCode } from "colyseus";
import { MyRoomState, Player } from "./schema/MyRoomState.js";

export class MyRoom extends Room {
  maxClients = 4;
  state = new MyRoomState();

  onCreate (options: any) {
    /**
     * Called when a new room is created.
     */
    console.log("Room created:", this.roomId);
    
    // Register message handlers
    this.onMessage('move', (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (player) {
        player.x = message.x;
        player.y = message.y;
        player.z = message.z;
        player.yaw = message.yaw;
        player.pitch = message.pitch;
      }
    });

    this.onMessage('shot', (client, message) => {
      // Broadcast shot to all clients
      this.broadcast('shot', {
        shooterId: client.sessionId,
        targetId: message.targetId,
        position: message.position,
        velocity: message.velocity
      });
    });
  }

  onJoin (client: Client, options: any) {
    /**
     * Called when a client joins the room.
     */
    console.log(client.sessionId, "joined!");
    
    // Create player for this client
    const player = new Player();
    player.x = 0;
    player.y = 150;
    player.z = 0;
    player.yaw = 0;
    player.pitch = 0;
    
    this.state.players.set(client.sessionId, player);
  }

  onLeave (client: Client, code: CloseCode) {
    /**
     * Called when a client leaves the room.
     */
    console.log(client.sessionId, "left!", code);
    
    // Remove player from state
    this.state.players.delete(client.sessionId);
  }

  onDispose() {
    /**
     * Called when the room is disposed.
     */
    console.log("room", this.roomId, "disposing...");
  }

}
