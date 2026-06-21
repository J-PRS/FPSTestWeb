class Main extends hxd.App {

  var game : Game;

  override function init() {
    hxd.Res.initEmbed();
    engine.backgroundColor = 0x00000000; // transparent - CSS gradient shows through
    game = new Game(s3d, s2d, engine);
  }

  override function update(dt: Float) {
    game.update(dt);
  }

  static function main() {
    new Main();
  }
}
