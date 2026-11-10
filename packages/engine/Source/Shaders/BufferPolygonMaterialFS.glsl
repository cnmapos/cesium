in vec4 v_pickColor;
in vec4 v_color;
#ifdef OUTLINE
in vec4 v_outlineColor;
in float v_outlineWidth;
#endif

void main()
{
#ifdef OUTLINE
    if (v_outlineWidth <= 0.0 || v_outlineColor.a < 0.005)
    {
        discard;
    }

    out_FragColor = czm_gammaCorrect(v_outlineColor);
#else
    if (v_color.a < 0.005)   // matches 0/255 and 1/255
    {
        discard;
    }

    out_FragColor = czm_gammaCorrect(v_color);
#endif
    czm_writeLogDepth();
}
