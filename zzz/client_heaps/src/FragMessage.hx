class FragMessage {

  var text   : h2d.Text;
  var age    : Float = 0.0;
  var life   : Float = 2.5;  // seconds to display
  public var dead   : Bool = false;

  // Stack messages vertically - base Y position
  static inline var BASE_Y = 80.0;
  static inline var LINE_HEIGHT = 35.0;

  // Track active message count for stacking
  static var activeCount : Int = 0;
  var myIndex : Int = 0;

  public function new(s2d: h2d.Scene, distance: Float, ?customMessage: String, ?customColor: Int, ?customLife: Float) {
    var font = hxd.res.DefaultFont.get();
    text = new h2d.Text(font, s2d);
    
    // Set custom life if provided
    if (customLife != null) {
      life = customLife;
    }

    if (customMessage != null) {
      text.text = customMessage;
      // Use custom color if provided, otherwise color code based on message type
      if (customColor != null) {
        text.textColor = customColor;
      } else if (customMessage.indexOf('killed') >= 0) {
        text.textColor = 0xFFFFFF; // White for kill messages
      } else if (customMessage.indexOf('HIT!') >= 0) {
        text.textColor = 0xFFAA44; // Orange for hit messages
      } else if (customMessage.indexOf('KILL PREDICTED') >= 0) {
        text.textColor = 0xFF6666; // Light red for kill prediction
      } else {
        text.textColor = 0xFF4444; // Default red
      }
    } else {
      text.text = Std.string(Math.round(distance));
      text.textColor = 0xFFAA44;
    }

    text.textAlign = Center;
    text.dropShadow = { dx: 1, dy: 1, color: 0x000000, alpha: 0.8 };
    text.setScale(1.2);
    // Upper center position with vertical offset based on message index
    text.x = s2d.width / 2;
    // Calculate Y position - newer messages appear lower
    myIndex = activeCount;
    activeCount++;
    text.y = BASE_Y + (myIndex * LINE_HEIGHT);
  }

  public function update(dt: Float) {
    age += dt;
    if (age >= life) {
      dead = true;
      text.remove();
      activeCount--;
      if (activeCount < 0) activeCount = 0;
      return;
    }
    // Fade out near end
    var t = age / life;
    if (t > 0.7) {
      text.alpha = 1.0 - (t - 0.7) / 0.3;
    }
    // No upward float - stay stationary
  }

  public function dispose() {
    text.remove();
    if (!dead) {
      activeCount--;
      if (activeCount < 0) activeCount = 0;
    }
  }
}
