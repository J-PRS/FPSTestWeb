-------------------------------------------------------------
Swinging Grappling Hook QuakeC Mod v1.3		7/18/97
Compiled with Quake v1.06 source code
-------------------------------------------------------------


Features
--------
- unprecedented use of true to life swinging physics
- ability to climb up or slide down the chain
- ability to hop off the chain with a slight upward boost
- ability to drill your opponents to death with the hook 
- undisturbed use of weapons during hook use
- for a laugh, watch the demo


Description
-----------
Grappling hook is a rotating iron shaft with claws, thrown by
a chain and used for grasping, drawing and holding. Can be
used for getting out of tight spots, getting to unreachable
places and even grabbing your enemy, inflicting great pain.
Grappling hook does not use any ammunition.


Files included
--------------
* hook.cfg - key bindings for Hook patch
* pak0.pak - packed file with all the modified resources
  hook.qc - source for the grappling hook
  readme.txt - this file

* the only files needed to run the patch


Installation
------------
In your Quake directory parallel to the id1 directory make
a new directory called "hook". In this directory, put 
pak0.pak and hook.cfg files supplied. Modify your keyboard 
preferences in hook.cfg with a text editor. From within the
quake directory start Quake with this command line:

quake -game hook


Usage
-----
The default keys for using the hook are:

    SHIFT = for launching or releasing the hook (if held down
            while launching, player gets pulled until release)  
        R = for pulling or climbing the chain
        W = for sliding down or giving slack to the chain
 Jump key = for hopping off the chain and releasing the hook

Note that these are just the keys that happen to fit well 
with my key configuration. You could change any of the default
keys, except the jump key, to ones of your choice by modifying
the hook.cfg with a text editor. The jump key can be changed
through the normal Quake interface. 


The most frequently asked questions
-----------------------------------
Q: The grappling hook works fine in single player mode but why
   doesn't it work when I play on the Internet?

A: Quake is one of the first games that runs on a true client
   server concept. The server runs the progs.dat(the compiled 
   QuakeC code) not the client. This means that only the server
   can be patched with a QuakeC modification. In a single player
   situation, you local machine runs both the server and the
   client, so the patch is being used. With Q95 you are playing
   over the Internet on somebody else's server. In this 
   situation your computer is only running the client and you
   can only play with the patches that the particular server
   you connected to has installed. Some patches may require
   the client to download some resources such as maps, sounds,
   models, skins, etc. but the client never runs the actual 
   QuakeC code. So, the only way to play the hook patch(or any
   other patch for that mater) over the Internet is to connect
   to a server that has it or urge the operator of that server
   to use the hook QuakeC mod. This design prevents people from
   having unfair advantages on net games and empowers the
   server operator with deciding the rules of the game.

Q: Why do the hook keys have a latent or sometimes no response on
   the client side when playing multi-player?

A: This problem is solved if you run a dedicated server. Listen 
   servers tend to not update the clients every 0.01 sec which is
   needed by the swinging hook in order for the physics code to
   act and feel realistic. Note that the sys_ticrate is also set
   to 0.01 in the hook.cfg. Since the server needs to update the
   clients so frequently it is now apparent why internet play
   with this patch is not feasible unless you have LAN comparable
   ping times.

 
Possible future enhancements
----------------------------
- Add a little friction to the swing.
- Change player running frames for when he is hanging of the 
  chain to something more appropriate.
- Add the possibility to grab power-ups and weapons with the 
  hook(only if it doesn't unbalance the game too much)
- When an object gets hit with the hook, add some impact
  velocity to it.	
- Add damage when face planting into a wall from swinging.


Credits
-------
QuakeC code and chain model by me: Perecli Manole AKA Bort
Hook model and sounds taken from the Morning Star patch by: 
Mike (Last name unknown)


If you need help or have any comments or suggestions
regarding this mod, my address is: Perecli@ix.netcom.com
Visit http://www.slip.net/~sargov/bort/ for updates.