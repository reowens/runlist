import AppKit
let size=NSSize(width:1024,height:1024)
let image=NSImage(size:size)
image.lockFocus()
NSColor(calibratedRed:0.12,green:0.13,blue:0.15,alpha:1).setFill()
NSBezierPath(roundedRect:NSRect(x:0,y:0,width:1024,height:1024),xRadius:210,yRadius:210).fill()
NSColor(calibratedRed:0.56,green:0.72,blue:0.96,alpha:1).setFill()
let slash=NSBezierPath();slash.move(to:NSPoint(x:349,y:220));slash.line(to:NSPoint(x:503,y:220));slash.line(to:NSPoint(x:684,y:804));slash.line(to:NSPoint(x:530,y:804));slash.close();slash.fill()
image.unlockFocus()
let rep=NSBitmapImageRep(data:image.tiffRepresentation!)!
try rep.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:CommandLine.arguments[1]))
