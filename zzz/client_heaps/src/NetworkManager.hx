class NetworkManager {
  
  var ws : js.html.WebSocket;
  var serverUrl : String;
  var connected : Bool = false;
  var playerId : String = null;
  var onMessageCallback : Dynamic->Void = null;
  var onConnectCallback : String->Void = null;
  
  // Network quality tracking
  var lastMessageTime : Float = 0;
  var messageCount : Int = 0;
  var packetLossCount : Int = 0;
  var networkQuality : Float = 1.0; // 0.0 to 1.0
  var lastPingTime : Float = 0;
  var currentLatency : Float = 0;
  var pingTimer : Float = 0;
  static inline var PING_INTERVAL = 1.0; // Send ping every 1 second
  
  // Auto-reconnect
  var reconnectAttempts : Int = 0;
  static inline var MAX_RECONNECT_ATTEMPTS = 5;
  static inline var RECONNECT_BASE_DELAY = 2.0; // seconds
  var reconnectTimer : Float = 0;
  var shouldReconnect : Bool = true;
  
  public function new(serverUrl: String) {
    this.serverUrl = serverUrl;
    tryConnect();
  }
  
  function tryConnect() {
    try {
      js.Browser.console.log('Connecting to ' + serverUrl + '...');
      ws = new js.html.WebSocket(serverUrl);
      ws.onopen = onOpen;
      ws.onmessage = onWsMessage;
      ws.onerror = onError;
      ws.onclose = onClose;
    } catch (e: Dynamic) {
      js.Browser.console.error('WebSocket connection failed: ' + e);
      scheduleReconnect();
    }
  }
  
  function scheduleReconnect() {
    if (!shouldReconnect || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      js.Browser.console.log('Max reconnection attempts reached or reconnect disabled');
      return;
    }
    reconnectAttempts++;
    reconnectTimer = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts - 1); // Exponential backoff
    js.Browser.console.log('Reconnecting in ' + reconnectTimer + 's (attempt ' + reconnectAttempts + '/' + MAX_RECONNECT_ATTEMPTS + ')');
  }
  
  function onOpen() {
    connected = true;
    reconnectAttempts = 0;
    reconnectTimer = 0;
    js.Browser.console.log('WebSocket connected');
  }
  
  function onWsMessage(event: js.html.MessageEvent) {
    try {
      var data = haxe.Json.parse(event.data);
      
      // Track network quality
      #if js
      var now = haxe.Timer.stamp();
      #else
      var now = Sys.time();
      #end
      messageCount++;
      
      // Detect packet loss (if no messages for > 500ms)
      if (lastMessageTime > 0 && (now - lastMessageTime) > 0.5) {
        packetLossCount++;
      }
      lastMessageTime = now;
      
      // Calculate network quality (0.0 to 1.0)
      if (messageCount > 10) {
        var lossRate = packetLossCount / messageCount;
        networkQuality = 1.0 - Math.min(lossRate * 5, 1.0); // Scale up loss impact
      }
      
      // Handle pong for latency measurement
      if (data.type == 'pong') {
        #if js
        var now = haxe.Timer.stamp();
        #else
        var now = Sys.time();
        #end
        currentLatency = (now - data.time) * 1000; // Convert to ms
      }
      
      if (data.type == 'init') {
        playerId = data.playerId;
        if (onConnectCallback != null) {
          onConnectCallback(playerId);
        }
      }
      
      if (onMessageCallback != null) {
        onMessageCallback(data);
      }
    } catch (e: Dynamic) {
      js.Browser.console.error('Error parsing message: ' + e);
    }
  }
  
  function onError(event: js.html.Event) {
    js.Browser.console.error('WebSocket error');
  }
  
  function onClose(event: js.html.CloseEvent) {
    connected = false;
    js.Browser.console.log('WebSocket disconnected');
    scheduleReconnect();
  }
  
  public function update(dt: Float) {
    // Handle reconnect timer
    if (reconnectTimer > 0) {
      reconnectTimer -= dt;
      if (reconnectTimer <= 0) {
        reconnectTimer = 0;
        tryConnect();
      }
    }
    
    // Send periodic ping for latency measurement
    if (connected) {
      pingTimer += dt;
      if (pingTimer >= PING_INTERVAL) {
        pingTimer = 0;
        sendPing();
      }
    }
  }
  
  public function sendPositionUpdate(pos: {x:Float, y:Float, z:Float}, rot: {x:Float, y:Float, z:Float}, ?seq: Int) {
    if (!connected) return;
    
    try {
      var msg = {
        type: 'positionUpdate',
        position: pos,
        rotation: rot
      };
      if (seq != null) {
        Reflect.setField(msg, 'seq', seq);
      }
      ws.send(haxe.Json.stringify(msg));
    } catch (e: Dynamic) {
      js.Browser.console.error('Error sending position: ' + e);
    }
  }
  
  public function sendBatchedPositionUpdates(updates: Array<{pos: {x:Float, y:Float, z:Float}, rot: {x:Float, y:Float, z:Float}, seq: Int}>) {
    if (!connected || updates.length == 0) return;
    
    try {
      ws.send(haxe.Json.stringify({
        type: 'positionUpdateBatch',
        updates: updates
      }));
    } catch (e: Dynamic) {
      js.Browser.console.error('Error sending batched positions: ' + e);
    }
  }
  
  public function sendRocketFire(pos: {x:Float, y:Float, z:Float}, dir: {x:Float, y:Float, z:Float}, ?timestamp: Float) {
    if (!connected) return;

    try {
      var msg = {
        type: 'rocketFire',
        position: pos,
        direction: dir
      };
      if (timestamp != null) {
        Reflect.setField(msg, 'timestamp', timestamp);
      }
      ws.send(haxe.Json.stringify(msg));
    } catch (e: Dynamic) {
      js.Browser.console.error('Error sending rocket fire: ' + e);
    }
  }
  
  public function sendRocketExplode(pos: {x:Float, y:Float, z:Float}) {
    if (!connected) return;
    
    try {
      ws.send(haxe.Json.stringify({
        type: 'rocketExplode',
        position: pos
      }));
    } catch (e: Dynamic) {
      js.Browser.console.error('Error sending rocket explode: ' + e);
    }
  }
  
  public function sendRocketExplodeWithPlayer(pos: {x:Float, y:Float, z:Float}, ?timestamp: Float) {
    if (!connected) return;

    try {
      var msg = {
        type: 'rocketExplode',
        playerId: playerId,
        position: pos
      };
      if (timestamp != null) {
        Reflect.setField(msg, 'timestamp', timestamp);
      }
      ws.send(haxe.Json.stringify(msg));
    } catch (e: Dynamic) {
      js.Browser.console.error('Error sending rocket explode: ' + e);
    }
  }
  
  public function sendSetName(name: String) {
    if (!connected) return;
    try {
      ws.send(haxe.Json.stringify({
        type: 'setName',
        name: name
      }));
    } catch (e: Dynamic) {
      js.Browser.console.error('Error sending setName: ' + e);
    }
  }
  
  public function setOnMessage(callback: Dynamic->Void) {
    onMessageCallback = callback;
  }
  
  public function onConnect(callback: String->Void) {
    onConnectCallback = callback;
  }
  
  public function getPlayerId() : String {
    return playerId;
  }
  
  public function isConnected() : Bool {
    return connected;
  }
  
  public function getNetworkQuality() : Float {
    return networkQuality;
  }
  
  public function getLatency() : Float {
    return currentLatency;
  }
  
  public function sendPing() {
    if (!connected) return;
    try {
      #if js
      lastPingTime = haxe.Timer.stamp();
      #else
      lastPingTime = Sys.time();
      #end
      ws.send(haxe.Json.stringify({
        type: 'ping',
        time: lastPingTime
      }));
    } catch (e: Dynamic) {
      js.Browser.console.error('Error sending ping: ' + e);
    }
  }
}
