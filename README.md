```
                       _/\/\/\_
                      /########\
                      |========}~~
                      |#(o  o)#|  ~
                   _.--'\ -- /'---._
                 .'::.  \    /  .::'.
                / .--.:  \  /  .:::  \
               ( /  .::.  \/ .:::.   \
               | |  .::_(mmm)::::.  .-.)
               ( '.__.'(___)::::::.(mm)
                '--.:::'---'::::::.'--'
                    |::::::.\#/.::::|
                    /::::::/##\::::.\
                   /:::::./###\%%~~%%%%
                 (______.'%%~~~ ~~%%%~~%%%%
             _.-'::...   ..:'%~~ ~~~%%%~~%%%%
          .-'::.      ..::::::'.%%~~~%%%%~~%%%%%
        .'::.       ..:.-""-._.-"""""-._~%%%%%%%
     _##':.        .:'   .    .    .   '.%~%%%%%
  ,/#@@@\:.      .:(   ..   ..   ..   .:)%%~~%%%
<#@@@@@@\::.   .::'.  .::  .:._______.'%%%%~~%%%
@@@@@@@@@\.:.\.__.-'-.______.-'::::.\%%~~%%%%%%%
<@@@@@(x *):::::.(::::::::(::::::(%%~~~%%%%~%%%
  @@@@\ ** /::::.)::::::::):::::|%%%%~~%%%%%%%%
    '@@@@'--'-.___/_________/____.'%%%%%%%%%%%%%
                      '------'%%%~~~%%%
```

![SQUAD's stage-2 boss, Daltonius, on every target shmupX exports to, a tool-assisted pilot fighting it: web, PS2, Super Famicom, Saturn, PS1 Kids!, PS1 Dezaemon+ and 64DD](docs/preview.gif)

_One level on all seven targets at once — the web, the PS2 build and the five
emulated originals — recorded by `deno task testdrive:parity`._

How to play with shmupX. Building, exporting and everything under the hood is in
the [technical README](README-Technical.md). How close each target plays a
Dezaemon 2 cart to the Saturn, and the plan to close the gap, is
[README-Parity.md](README-Parity.md); the weapon systems of every target and
what it takes to drop any Dezaemon weapon as an item is
[README-Weapons.md](README-Weapons.md).

## Legion Go: play on a monitor, use the handheld's screen as the controller

Docked your Legion Go to a monitor but left the controller in the bag, or just
don't feel like attaching it? shmupX can put the game on the monitor and turn the
Legion's own touchscreen into your controller.

### What you need

- The **shmupX desktop launcher for Linux** (the `.AppImage`), running on the
  Legion. The web version and the Windows launcher can't do this yet.
- **Desktop Mode.** On Bazzite or SteamOS, switch out of Game Mode first. Game
  Mode only drives one screen at a time.
- A **monitor connected** to the Legion.
- **No gamepad connected.** The controller screen is for when you don't have a
  pad in hand. Plug one in and shmupX uses that instead.

It works best with the Legion set to show the picture on the external display
only while a monitor is connected. shmupX turns the built-in screen back on just
for the controller and puts everything back afterward.

### Playing

1. Dock the Legion and connect the monitor.
2. Open shmupX in Desktop Mode.
3. Start any game.

The game stays on the monitor. The Legion's screen lights up beside it with an
on-screen controller, and the top of that screen shows which game it's
controlling.

What the controller looks like depends on the game:

- **Twin-stick games** (like Sh'M↑ Party) get two floating sticks, one on each
  half of the screen. Put a thumb down anywhere on a side and drag.
- **Every other game** gets a stick that also works as the D-pad, plus A, B, X
  and Y, the shoulder buttons, SELECT and START.

The Legion's screen stays awake while you play, so it won't dim or lock in the
middle of a run.

### Stopping or switching back

Any of these puts your screens back exactly how they were:

- **Quit the game.**
- **Connect a real controller.** shmupX switches to it, and the touch controller
  closes on its own.
- **Tap PLAY HERE** on the controller screen. This stops using the built-in
  screen as a controller for the rest of that game. Use it right before you
  undock or pick up a real pad.
- **Close the controller window** or **quit shmupX.**

Plugging the monitor in partway through a game works too. shmupX notices within
a few seconds.

### Turning it on or off

Open **Settings** in the launcher:

- **CONTROLLER SCREEN**: ON (the default) sends the controller to the Legion's
  screen whenever a monitor is connected. OFF keeps it as an overlay on top of
  the game instead.
- **TOUCH CONTROLLER**: switches the on-screen controller off entirely, so games
  wait for a real pad. You can also flip this mid-game from the Guide's **Touch
  Controller** row.

### If it doesn't show up

- **Settings says Game Mode shows one display at a time.** Switch to Desktop
  Mode and start the game again.
- **There's no CONTROLLER SCREEN row in Settings at all.** This setup can't do
  it. Check that you're running the Linux `.AppImage` (not the browser version
  or the Windows launcher), and that your desktop lets apps rearrange screens.
  KDE Plasma, the Bazzite and SteamOS default, does. GNOME on Wayland doesn't.
- **The game started on the monitor but no controller appeared.** Make sure no
  gamepad is connected, including the Legion's own detached controller switched
  on in your bag.

When the controller screen can't open, you still get the touch controller as an
overlay on top of the game wherever there's a touchscreen.
