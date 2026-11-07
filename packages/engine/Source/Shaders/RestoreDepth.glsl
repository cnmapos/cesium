uniform highp sampler2D u_depthTexture;

in vec2 v_textureCoordinates;

void main()
{
    gl_FragDepth = czm_unpackDepth(texture(u_depthTexture, v_textureCoordinates));
}
