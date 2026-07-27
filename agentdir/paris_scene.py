import bpy, math, random
from mathutils import Vector

# Clear scene
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Helpers

def mat(name, color, metallic=0.0, roughness=0.5, emission=None):
    m=bpy.data.materials.new(name)
    m.diffuse_color=(*color,1)
    m.use_nodes=True
    bsdf=m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value=(*color,1)
    bsdf.inputs['Metallic'].default_value=metallic
    bsdf.inputs['Roughness'].default_value=roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value=(*emission,1)
        bsdf.inputs['Emission Strength'].default_value=2.0
    return m

def cube(name, loc, scale, material, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o=bpy.context.object; o.name=name; o.scale=scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod=o.modifiers.new('Bevel','BEVEL'); mod.width=bevel; mod.segments=3
    o.data.materials.append(material)
    return o

def cyl(name, loc, radius, depth, material, vertices=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=loc)
    o=bpy.context.object; o.name=name; o.data.materials.append(material); return o

def beam_between(name, a, b, radius, material):
    a,b=Vector(a),Vector(b); mid=(a+b)/2; d=b-a
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=radius, depth=d.length, location=mid)
    o=bpy.context.object; o.name=name; o.data.materials.append(material)
    o.rotation_mode='QUATERNION'; o.rotation_quaternion=d.to_track_quat('Z','Y')
    return o

stone=mat('Paris Stone',(0.63,0.52,0.40),roughness=0.72)
stone2=mat('Warm Limestone',(0.78,0.68,0.55),roughness=0.68)
roof=mat('Slate Roof',(0.12,0.15,0.18),metallic=0.1,roughness=0.55)
road=mat('Road',(0.035,0.04,0.05),roughness=0.9)
walk=mat('Pavement',(0.35,0.36,0.34),roughness=0.85)
water=mat('Seine Water',(0.035,0.18,0.26),metallic=0.15,roughness=0.2)
metal=mat('Tower Iron',(0.16,0.11,0.07),metallic=0.75,roughness=0.35)
green=mat('Trees',(0.06,0.22,0.08),roughness=0.8)
trunk=mat('Trunks',(0.18,0.08,0.03),roughness=0.9)
lightmat=mat('Warm Lights',(1.0,0.42,0.08),roughness=0.3,emission=(1.0,0.22,0.03))

# Ground and Seine
cube('Ground',(0,0,-0.6),(42,32,0.5),walk)
cube('Seine',(0,0,0),(42,5.5,0.22),water,0.15)
# embankments
cube('North Embankment',(0,6.4,0.2),(42,0.8,0.4),stone)
cube('South Embankment',(0,-6.4,0.2),(42,0.8,0.4),stone)

# Bridges
for x in (-24,0,24):
    cube(f'Bridge{x}',(x,0,1.1),(3.6,7.2,0.55),stone2,0.35)
    for y in (-5.8,5.8):
        cube('BridgeRail',(x,y,2.1),(3.6,0.15,0.45),metal,0.08)

# Streets
for y in (-12,12,20,-20): cube('Avenue',(0,y,0.05),(42,2.4,0.08),road)
for x in (-32,-16,16,32): cube('Cross Street',(x,0,0.06),(2.2,32,0.08),road)

# Parisian building blocks
random.seed(8)
for side in (-1,1):
    ys=[side*10, side*16, side*24]
    for y in ys:
        for x in range(-36,37,8):
            if abs(x)<8 and abs(y)<14: continue
            h=random.uniform(4.5,8.0)
            m=stone if random.random()<0.55 else stone2
            b=cube('Haussmann Building',(x,y,h/2+0.2),(3.1,2.5,h/2),m,0.12)
            # roof
            r=cube('Mansard Roof',(x,y,h+0.65),(3.25,2.65,0.65),roof,0.08)
            r.scale.z=0.65
            # window lights
            for z in (2.0,3.8,5.6):
                if z<h-0.3:
                    for dx in (-1.5,0,1.5):
                        cube('Window',(x+dx,y-side*2.56,z),(0.28,0.05,0.42),lightmat,0.03)

# Trees along river
for x in range(-36,37,6):
    for y in (-8.2,8.2):
        cyl('Tree Trunk',(x,y,1.05),0.18,2.1,trunk,16)
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,radius=1.15,location=(x,y,2.6))
        bpy.context.object.data.materials.append(green)

# Eiffel Tower at south-west
base=(-15,-14,0.6)
leg_pts=[(-19,-18,0.6),(-11,-18,0.6),(-19,-10,0.6),(-11,-10,0.6)]
top=(-15,-14,24)
for i,p in enumerate(leg_pts):
    beam_between(f'Tower Leg {i}',p,top,0.34,metal)
# platforms
for z,s in ((7,3.6),(13,2.2),(19,1.15)):
    cube('Tower Platform',(-15,-14,z),(s,s,0.28),metal,0.08)
# cross bracing levels
for z,span in ((3,3.2),(6,2.8),(10,2.1),(14,1.5),(18,0.9)):
    pts=[(-15-span,-14-span,z),(-15+span,-14-span,z),(-15+span,-14+span,z),(-15-span,-14+span,z)]
    for i in range(4): beam_between('Tower Brace',pts[i],pts[(i+1)%4],0.12,metal)
# antenna
cyl('Antenna',(-15,-14,25.3),0.16,2.8,metal,12)

# Arc-like monument in distance
cube('Arch Pillar L',(18,18,4.5),(2,2.4,4.5),stone2,0.2)
cube('Arch Pillar R',(24,18,4.5),(2,2.4,4.5),stone2,0.2)
cube('Arch Top',(21,18,8.3),(5,2.4,1.2),stone2,0.2)

# Boats
for x in (-10,12):
    cube('River Boat',(x,0,0.7),(2.6,0.85,0.45),stone2,0.3)
    cube('Boat Cabin',(x,0,1.45),(1.5,0.65,0.45),roof,0.15)

# Lighting
bpy.ops.object.light_add(type='SUN', location=(0,0,30))
sun=bpy.context.object; sun.rotation_euler=(math.radians(28),math.radians(-18),math.radians(135)); sun.data.energy=2.2
bpy.ops.object.light_add(type='AREA', location=(-10,-8,28))
area=bpy.context.object; area.data.energy=1400; area.data.shape='DISK'; area.data.size=18

# World
world=bpy.context.scene.world or bpy.data.worlds.new('World')
bpy.context.scene.world=world; world.use_nodes=True
world.node_tree.nodes['Background'].inputs['Color'].default_value=(0.035,0.055,0.11,1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value=0.55

# Camera
bpy.ops.object.camera_add(location=(48,-48,34))
cam=bpy.context.object; bpy.context.scene.camera=cam

def look_at(obj, target):
    direction=Vector(target)-obj.location
    obj.rotation_euler=direction.to_track_quat('-Z','Y').to_euler()
look_at(cam,(-4,-3,7))
cam.data.lens=48

scene=bpy.context.scene
scene.render.engine='BLENDER_EEVEE'
scene.render.resolution_x=1280; scene.render.resolution_y=720; scene.render.resolution_percentage=100
scene.render.image_settings.file_format='PNG'
scene.render.filepath='/Users/hardikarora/Desktop/MAIN/chatgpt code /agentdir/paris_city.png'
scene.render.film_transparent=False
scene.view_settings.look='AgX - Medium High Contrast'

# Add slight mist
scene.world.color=(0.02,0.03,0.06)

bpy.ops.wm.save_as_mainfile(filepath='/Users/hardikarora/Desktop/MAIN/chatgpt code /agentdir/paris_city.blend')
bpy.ops.render.render(write_still=True)
print('PARIS_SCENE_DONE')
