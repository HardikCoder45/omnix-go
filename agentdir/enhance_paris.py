import bpy, math, random
from mathutils import Vector

# Materials helper

def make_mat(name, color, metallic=0.0, roughness=0.5, emission=None, strength=1.0):
    m=bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes=True
    bsdf=m.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value=(*color,1)
    bsdf.inputs['Metallic'].default_value=metallic
    bsdf.inputs['Roughness'].default_value=roughness
    if emission:
        bsdf.inputs['Emission Color'].default_value=(*emission,1)
        bsdf.inputs['Emission Strength'].default_value=strength
    return m

def cube(name, loc, scale, mat, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o=bpy.context.object; o.name=name; o.scale=scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        mod=o.modifiers.new('Bevel','BEVEL'); mod.width=bevel; mod.segments=3
    o.data.materials.append(mat)
    return o

def cyl(name, loc, r, depth, mat, verts=24):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc)
    o=bpy.context.object; o.name=name; o.data.materials.append(mat); return o

def sphere(name, loc, r, mat):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=r, location=loc)
    o=bpy.context.object; o.name=name; o.data.materials.append(mat); return o

metal=make_mat('Decorative Iron',(0.03,0.025,0.02),metallic=0.8,roughness=0.28)
gold=make_mat('Golden Glow',(0.65,0.28,0.03),metallic=0.25,roughness=0.25,emission=(1.0,0.22,0.03),strength=5)
cream=make_mat('Cafe Cream',(0.72,0.18,0.12),roughness=0.7)
red=make_mat('Awning Red',(0.45,0.015,0.02),roughness=0.6)
green=make_mat('Deep Foliage',(0.02,0.18,0.05),roughness=0.85)
flower=make_mat('Flowers',(0.8,0.04,0.15),roughness=0.55)
stone=make_mat('Monument Stone',(0.78,0.66,0.50),roughness=0.72)
carpaint=make_mat('Car Paint',(0.03,0.07,0.16),metallic=0.7,roughness=0.22)
white=make_mat('Car White',(0.75,0.78,0.82),metallic=0.25,roughness=0.25)
waterglow=make_mat('Water Accent',(0.02,0.25,0.38),metallic=0.2,roughness=0.12)

# Street lamps along both embankments
for x in range(-36, 37, 6):
    for y in (-7.4, 7.4):
        cyl('Lamp Post',(x,y,1.25),0.08,2.5,metal,16)
        sphere('Lamp Globe',(x,y,2.55),0.20,gold)
        # soft point light
        bpy.ops.object.light_add(type='POINT', location=(x,y,2.55))
        l=bpy.context.object; l.data.energy=90; l.data.color=(1.0,0.38,0.12); l.data.shadow_soft_size=1.1

# Decorative bridge arches and lamps
for x in (-24,0,24):
    for yy in (-4.0,0,4.0):
        # support columns
        cyl('Bridge Pier',(x,yy,0.45),0.42,1.4,stone,20)
    for sx in (-2.6,2.6):
        for y in (-5.8,5.8):
            sphere('Bridge Lamp',(x+sx,y,2.75),0.16,gold)
            cyl('Bridge Lamp Post',(x+sx,y,2.05),0.06,1.35,metal,12)

# Cafe terraces on north bank
for x in (-28,-12,10,28):
    y=9.0
    cube('Cafe Front',(x,y,0.55),(2.0,0.7,0.55),cream,0.15)
    cube('Cafe Awning',(x,y-0.78,1.35),(2.1,0.55,0.12),red,0.12)
    for dx in (-1.2,0,1.2):
        cyl('Cafe Table',(x+dx,y-1.5,0.55),0.33,0.08,metal,20)
        cyl('Cafe Stem',(x+dx,y-1.5,0.3),0.05,0.5,metal,12)
        for chair_dx in (-0.55,0.55):
            cube('Cafe Chair',(x+dx+chair_dx,y-1.5,0.35),(0.18,0.18,0.35),metal,0.06)

# Planters and flowers
for x in range(-34,35,4):
    for y in (-8.3,8.3):
        cube('Planter',(x,y,0.38),(0.55,0.28,0.28),stone,0.08)
        for dx in (-0.25,0,0.25):
            sphere('Flower',(x+dx,y,0.8),0.18,flower)

# Add a domed landmark in the distance
cyl('Dome Drum',(8,23,7.5),3.2,2.0,stone,48)
bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=3.35, location=(8,23,9.2))
dome=bpy.context.object; dome.name='Paris Dome'; dome.scale.z=0.65; dome.data.materials.append(gold)
cyl('Dome Lantern',(8,23,11.2),0.55,1.4,stone,24)
sphere('Dome Crown',(8,23,12.15),0.38,gold)

# Notre-Dame-inspired twin towers silhouette
for tx in (-31,-26):
    cube('Cathedral Tower',(tx,22,6.0),(2.0,2.4,6.0),stone,0.18)
    # corner pinnacles
    for dx in (-1.5,1.5):
        for dy in (-1.8,1.8):
            cyl('Pinnacle',(tx+dx,22+dy,12.5),0.16,1.1,metal,12)
# nave and rose window
cube('Cathedral Nave',(-28.5,22,4.0),(4.5,2.6,4.0),stone,0.18)
sphere('Rose Window',(-28.5,19.35,6.5),0.9,gold)

# Cars on avenues
for i,(x,y,rot,mat) in enumerate([(-25,-12,0,carpaint),(-5,12,math.pi,white),(18,-20,0,white),(30,20,math.pi,carpaint)]):
    body=cube(f'Car {i}',(x,y,0.55),(1.15,0.52,0.32),mat,0.22)
    body.rotation_euler.z=rot
    cabin=cube(f'Car Cabin {i}',(x,y,0.95),(0.62,0.42,0.28),mat,0.16); cabin.rotation_euler.z=rot
    for dx in (-0.7,0.7):
        for dy in (-0.48,0.48):
            cyl('Wheel',(x+dx*math.cos(rot)-dy*math.sin(rot),y+dx*math.sin(rot)+dy*math.cos(rot),0.35),0.18,0.16,metal,16)

# Boat lights and wake accents
for x in (-10,12):
    for dx in (-1.6,1.6): sphere('Boat Light',(x+dx,0,1.35),0.12,gold)
    cube('Boat Wake',(x-3.0,0,0.28),(2.2,0.08,0.025),waterglow,0.02)

# Small stars in skyline
for i in range(70):
    random.seed(100+i)
    px=random.uniform(-42,42); py=random.uniform(-5,32); pz=random.uniform(20,38)
    sphere('Star',(px,py,pz),random.uniform(0.025,0.07),gold)

# Improve Eiffel tower lighting
for z in (4,8,12,16,20,23):
    bpy.ops.object.light_add(type='POINT', location=(-15,-14,z))
    l=bpy.context.object; l.data.energy=180 if z<16 else 120; l.data.color=(1.0,0.24,0.05); l.data.shadow_soft_size=2.2

# Add subtle atmospheric volume cube
fogmat=bpy.data.materials.new('Atmospheric Fog'); fogmat.use_nodes=True
nodes=fogmat.node_tree.nodes; links=fogmat.node_tree.links
for n in list(nodes): nodes.remove(n)
out=nodes.new('ShaderNodeOutputMaterial'); vol=nodes.new('ShaderNodeVolumePrincipled')
vol.inputs['Density'].default_value=0.008
vol.inputs['Color'].default_value=(0.08,0.11,0.18,1)
links.new(vol.outputs['Volume'],out.inputs['Volume'])
fog=cube('Atmosphere',(0,4,12),(45,34,16),fogmat)

# Camera refinement
cam=bpy.data.objects.get('Camera')
if cam:
    cam.location=(52,-52,30)
    target=Vector((-3,-2,7.5)); cam.rotation_euler=(target-cam.location).to_track_quat('-Z','Y').to_euler()
    cam.data.lens=52

scene=bpy.context.scene
scene.render.resolution_x=1440; scene.render.resolution_y=810; scene.render.resolution_percentage=100
scene.render.filepath='/Users/hardikarora/Desktop/MAIN/chatgpt code /agentdir/paris_city_beautiful.png'
scene.render.image_settings.file_format='PNG'
scene.render.engine='BLENDER_EEVEE'
scene.view_settings.look='AgX - Medium High Contrast'

# Better quality
scene.render.image_settings.color_mode='RGBA'

bpy.ops.wm.save_as_mainfile(filepath='/Users/hardikarora/Desktop/MAIN/chatgpt code /agentdir/paris_city_beautiful.blend')
bpy.ops.render.render(write_still=True)
print('PARIS_ENHANCEMENT_DONE')
