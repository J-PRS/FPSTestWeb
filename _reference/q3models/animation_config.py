"""Parse Quake 3 animation.cfg files."""

from md3_types import Animation, AnimNumber


class AnimationConfig:
    def __init__(self, data):
        self.animations = [Animation() for _ in range(AnimNumber.MAX_TOTALANIMATIONS)]
        self.fixed_legs = False
        self.fixed_torso = False

        # Try UTF-8 first, then Latin-1
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            text = data.decode('latin-1')

        self._parse(text)

    def _parse(self, text):
        # Tokenize: split into lines, process sequentially
        lines = text.replace('\r\n', '\n').replace('\r', '\n').split('\n')
        tokens = []

        for line in lines:
            # Strip comments
            comment_idx = line.find('//')
            if comment_idx != -1:
                line = line[:comment_idx]
            line = line.strip()
            if line:
                tokens.extend(line.split())

        pos = 0
        skip = 0

        # Skip optional header keywords
        while pos < len(tokens):
            token = tokens[pos]

            # If it starts with a digit or minus, we've reached animation data
            if token[0].isdigit() or (token[0] == '-' and len(token) > 1 and token[1].isdigit()):
                break

            lower = token.lower()
            if lower == 'footsteps':
                pos += 2  # skip footstep type
            elif lower == 'headoffset':
                pos += 4  # skip 3 floats
            elif lower == 'sex':
                pos += 2  # skip sex type
            elif lower == 'fixedlegs':
                self.fixed_legs = True
                pos += 1
            elif lower == 'fixedtorso':
                self.fixed_torso = True
                pos += 1
            else:
                pos += 1  # skip unknown keyword

        # Parse animation entries (4 values each: firstFrame numFrames loopFrames fps)
        for i in range(AnimNumber.MAX_ANIMATIONS):
            if pos + 3 >= len(tokens):
                # Handle missing team animations
                if AnimNumber.TORSO_GETFLAG <= i <= AnimNumber.TORSO_NEGATIVE:
                    self.animations[i] = Animation(
                        firstFrame=self.animations[AnimNumber.TORSO_GESTURE].firstFrame,
                        numFrames=self.animations[AnimNumber.TORSO_GESTURE].numFrames,
                        loopFrames=self.animations[AnimNumber.TORSO_GESTURE].loopFrames,
                        frameLerp=self.animations[AnimNumber.TORSO_GESTURE].frameLerp,
                        reversed=self.animations[AnimNumber.TORSO_GESTURE].reversed,
                        flipflop=self.animations[AnimNumber.TORSO_GESTURE].flipflop,
                    )
                    continue
                break

            # firstFrame
            first_frame = int(tokens[pos]); pos += 1

            self.animations[i].firstFrame = first_frame

            # Compute leg frame offset at LEGS_WALKCR
            if i == AnimNumber.LEGS_WALKCR:
                skip = self.animations[AnimNumber.LEGS_WALKCR].firstFrame - \
                       self.animations[AnimNumber.TORSO_GESTURE].firstFrame
            if AnimNumber.LEGS_WALKCR <= i < AnimNumber.TORSO_GETFLAG:
                self.animations[i].firstFrame -= skip

            # numFrames (negative means reversed)
            num_frames = int(tokens[pos]); pos += 1
            self.animations[i].reversed = 0
            self.animations[i].flipflop = 0
            if num_frames < 0:
                num_frames = -num_frames
                self.animations[i].reversed = 1
            self.animations[i].numFrames = num_frames

            # loopFrames
            self.animations[i].loopFrames = int(tokens[pos]); pos += 1

            # fps -> frameLerp
            fps = float(tokens[pos]); pos += 1
            if fps == 0:
                fps = 1
            self.animations[i].frameLerp = int(1000.0 / fps)

        # Extra animations
        self.animations[AnimNumber.LEGS_BACKCR] = Animation(
            firstFrame=self.animations[AnimNumber.LEGS_WALKCR].firstFrame,
            numFrames=self.animations[AnimNumber.LEGS_WALKCR].numFrames,
            loopFrames=self.animations[AnimNumber.LEGS_WALKCR].loopFrames,
            frameLerp=self.animations[AnimNumber.LEGS_WALKCR].frameLerp,
            reversed=1,
            flipflop=self.animations[AnimNumber.LEGS_WALKCR].flipflop,
        )
        self.animations[AnimNumber.LEGS_BACKWALK] = Animation(
            firstFrame=self.animations[AnimNumber.LEGS_WALK].firstFrame,
            numFrames=self.animations[AnimNumber.LEGS_WALK].numFrames,
            loopFrames=self.animations[AnimNumber.LEGS_WALK].loopFrames,
            frameLerp=self.animations[AnimNumber.LEGS_WALK].frameLerp,
            reversed=1,
            flipflop=self.animations[AnimNumber.LEGS_WALK].flipflop,
        )

        self.animations[AnimNumber.FLAG_RUN] = Animation(
            firstFrame=0, numFrames=16, loopFrames=16,
            frameLerp=int(1000.0 / 15.0), reversed=0, flipflop=0,
        )
        self.animations[AnimNumber.FLAG_STAND] = Animation(
            firstFrame=16, numFrames=5, loopFrames=0,
            frameLerp=int(1000.0 / 20.0), reversed=0, flipflop=0,
        )
        self.animations[AnimNumber.FLAG_STAND2RUN] = Animation(
            firstFrame=16, numFrames=5, loopFrames=1,
            frameLerp=int(1000.0 / 15.0), reversed=1, flipflop=0,
        )
