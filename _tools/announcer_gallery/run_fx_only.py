# Re-run just the FX pass (skips re-rendering bases).
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_announcer import fxpass
fxpass()
print('fx done')
